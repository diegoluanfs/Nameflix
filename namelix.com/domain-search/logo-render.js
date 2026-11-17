/**
 * Logo Renderer Module (Title + Flush Slogan, Scaled & Centered)
 * * Interfaces with the rendering backend, replaces glyphs with custom fonts/ligatures, 
 * computes bounding boxes, handles multi-line text wrapping, forces single-line slogans 
 * to be flush with the title, distributes elements, and scales/centers the final composition.
 */

const renderCache = new Map();

// --- Hardcoded Canvas Dimensions ---
const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 768;
const CANVAS_CENTER_X = CANVAS_WIDTH / 2;
const CANVAS_CENTER_Y = CANVAS_HEIGHT / 2;

function toQueryString(obj, prefix) {
    const str = [];
    for (let p in obj) {
        if (obj.hasOwnProperty(p)) {
            const k = prefix ? prefix + "[" + p + "]" : p;
            const v = obj[p];
            str.push((v !== null && typeof v === "object") ?
                toQueryString(v, k) :
                encodeURIComponent(k) + "=" + encodeURIComponent(v));
        }
    }
    return str.join("&");
}

function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
}

function guidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function getCharacter(chars, ch) {
    for (let i = 0; i < chars.length; i++) {
        if (chars[i].character === ch) return chars[i];
    }
    return false;
}

function getElement(elements, id) {
    for (let i = 0; i < elements.length; i++) {
        if (elements[i][0].trim() === id.trim()) return elements[i];
    }
    return false;
}

function replaceGradientIds(svgString) {
    for (let i = 1; i < 15; i++) {
        const id = guidv4();
        svgString = svgString.replace(new RegExp('SVGID_' + i + '_', 'g'), id);
    }
    return svgString;
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function fetchLogoData(payload, maxRetries = 30) {
    const cacheKey = JSON.stringify(payload);
    if (renderCache.has(cacheKey)) {
        return renderCache.get(cacheKey);
    }

    const queryStr = toQueryString({ ...payload, v3: true });
    const url = `//render.namelix.com/process?${queryStr}`;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const fetchUrl = attempt > 10 ? '/logo-render-worker?' + queryStr : url;
            
            const response = await fetch(fetchUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                console.error(`[LogoRenderer] HTTP Error ${response.status} on attempt ${attempt}`);
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            if (data) {
                renderCache.set(cacheKey, data);
                return data;
            }
        } catch (error) {
            console.warn(`[LogoRenderer] Fetch attempt ${attempt} failed:`, error.message);
            if (error.name === 'AbortError' || attempt >= maxRetries) {
                if (attempt >= maxRetries) {
                    console.error("[LogoRenderer] Max retries reached. Failing out.");
                    throw new Error("Max retries reached");
                }
            }
        }
        await sleep(500); 
    }
}

function replaceSVGLogic(svgString, elements, logo) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(svgString, 'text/xml');
    const customFonts = window.custom_fonts || {};
    const customLigatures = window.custom_ligatures || {};

    // ONLY process the title to avoid blowing up the slogan with mismatched color glyphs
    const family = logo.titleFamily;
    const text = logo.title;
    
    if (!family || !text || !(family.includes('Color') || family.includes('Shadow') || family.includes('Gradient') || family.includes('Spectrum'))) {
        return svgString;
    }

    const font = customFonts[family] || [];
    const ligatures = customLigatures[family] || [];
    const textStripped = text.replace(/\s+/g, '');
    const letters = [];

    for (let i = 0; i < textStripped.length; i++) {
        const c1 = textStripped.charAt(i).trim();
        const c2 = i < textStripped.length - 1 ? textStripped.charAt(i + 1).trim() : '';

        if (family.startsWith('Brandmark') && (c1 === '~' || c1 === '^' || c2 === '_')) {
            letters.push(c1 + c2);
            i++;
        } else if (family.startsWith('Brandmark') && c1 === '(' && i + 3 < textStripped.length && textStripped.charAt(i + 3) === ')' && ligatures.includes(textStripped.substring(i + 1, i + 3))) {
            letters.push(textStripped.substring(i, i + 4));
            i += 3;
        } else {
            if (c1 !== '') letters.push(c1);
        }
    }

    const titleNode = xmlDoc.getElementById('title');
    if (!titleNode) return svgString;

    const toAdd = [], toDelete = [], ids = [], characters = [];
    let letterIdx = 0;
    const childNodes = titleNode.childNodes;
    
    for (let j = 0; j < childNodes.length; j++) {
        const child = childNodes[j];
        if (child.getAttribute) {
            const id = child.getAttribute('id');
            const ch = getCharacter(font, letters[letterIdx]);
            letterIdx++;
            
            if (!ch) continue;

            const group = parser.parseFromString(replaceGradientIds(ch.svg), 'text/xml').documentElement;
            characters.push(ch);
            toDelete.push(child);
            toAdd.push(group);
            ids.push(id);
        }
    }

    for (let i = 0; i < toDelete.length; i++) {
        let group = toAdd[i];
        group = titleNode.appendChild(group);

        if (!group) continue;
        if (titleNode.replaceChild(group, toDelete[i]) === false) continue;

        const id = ids[i];
        group.setAttribute('id', id);
        const ch = characters[i];
        const el = getElement(elements, id);
        group.setAttribute('aria-label', ch.character);

        if (!el) continue;
        
        const x = el[1] - ch.offsetx;
        const y = el[2] - ch.offsety;

        const groupChildren = group.childNodes;
        for (let j = 0; j < groupChildren.length; j++) {
            const child = groupChildren[j];
            if (child.tagName && child.tagName !== 'linearGradient') {
                child.setAttribute('transform', `translate(${x} ${y})`);
            }
        }
    }

    return new XMLSerializer().serializeToString(xmlDoc);
}

function getCharBox(key, bbox) {
    const chars = [];
    let found = false;
    for (let i = 0; i < bbox.length; i++) {
        if (bbox[i].id === key) {
            found = true;
        } else if (found) {
            if (bbox[i].id.substr(0, 4) === 'path') {
                if (bbox[i].width < 0.000001 || bbox[i].height < 0.000001) continue;
                chars.push(bbox[i]);
            } else {
                break;
            }
        }
    }
    return chars;
}

function wrap(key, input, bounds, scale, letterspacing, linespacing, align, bbox, logo) {
    const chars = getCharBox(key, bbox);
    const family = key === 'title' ? logo.titleFamily : logo.sloganFamily;

    function getwordwidth(word, s, lSpacing) {
        s = parseFloat(s);
        lSpacing = parseFloat(lSpacing);
        let width = 0;
        let first = true;
        for (let i = 0; i < word.length; i++) {
            if (isNumeric(word[i].kerning) && !first) {
                width += (word[i].kerning + lSpacing) * s;
            }
            if (word[i].width > 0.000001) {
                width += word[i].width * s;
                first = false;
            }
        }
        return width;
    }

    input = (input || "").split(/[ \t\r]+/).join(' ');
    const words = input.match(/\S+/g);

    if (!words) {
        return { bounds: { x: bounds.x, y: bounds.y, width: 0, height: 0 }, lines: [], transforms: [] };
    }
    
    const inputArray = input.split('');
    const blacklist = [127];
    const lines = [];
    let w = 0;
    let index = 0;

    for (let i = 0; i < words.length; i++) {
        const line = [];
        const tokens = [];
        
        for (let j = 0; j < words[i].length; j++) {
            let c1 = words[i].substr(j, 1);
            let c2 = j < words[i].length - 1 ? words[i].substr(j + 1, 1) : '';
            const code1 = words[i].charCodeAt(j);
            const code2 = j < words[i].length - 1 ? words[i].charCodeAt(j + 1) : 0;
            
            if (code1 < 33 || blacklist.includes(code1)) c1 = '';
            if (code2 < 33 || blacklist.includes(code2)) c2 = '';
            
            if (family && family.startsWith('Brandmark') && (c1 === '~' || c1 === '^' || c2 === '_')) {
                tokens.push(c1 + c2);
                j++;
            } else if (family && family.startsWith('Brandmark') && (c1 === '(' && j + 3 < words[i].length && words[i].substr(j + 3, 1) === ')')) {
                tokens.push(c1 + c2 + words[i].substr(j + 2, 2));
                j += 3;
            } else {
                if (c1) tokens.push(c1);
            }
        }
                        
        for (let j = 0; j < tokens.length; j++) {
            const c = tokens[j];
            const character = chars.shift();
            if (!character) continue;
            character.letter = c;
            line.push(character);
        }

        const wordwidth = getwordwidth(line, scale, letterspacing);

        if (lines.length === 0 || (index - 1 >= 0 && inputArray[index - 1] === '\n')) {
            lines.push(line);
            w = wordwidth;
        } else if (line.length > 0) {
            if (w + (line[0].kerning + letterspacing) * scale + wordwidth > bounds.width) {
                lines.push(line);
                w = wordwidth;
            } else {
                lines[lines.length - 1] = lines[lines.length - 1].concat(line);
                w += (line[0].kerning + letterspacing) * scale + wordwidth;
            }
        }
        index += words[i].length + 1;
    }

    let { y } = bounds;
    let offsety = 0;
    
    if (lines && lines[0] && lines[0].length > 0) {
        offsety = lines[0][0].y;
    }
    for (let i = 0; i < lines.length; i++) {
        for (let j = 0; j < lines[i].length; j++) {
            if (lines[i][j].y < offsety) offsety = lines[i][j].y;
        }
    }

    let minx = CANVAS_WIDTH, miny = CANVAS_HEIGHT, maxx = 0, maxy = 0;
    const transforms = [];

    for (let i = 0; i < lines.length; i++) {
        let { x } = bounds;

        if (align === 'center') {
            x = bounds.x + (bounds.width - getwordwidth(lines[i], scale, letterspacing)) / 2;
        } else if (align === 'right') {
            x = bounds.x + (bounds.width - getwordwidth(lines[i], scale, letterspacing));
        }

        if (x < minx) minx = x;

        let maxheight = 0;
        for (let j = 0; j < lines[i].length; j++) {
            const letter = lines[i][j];

            if (j > 0 && isNumeric(letter.kerning)) {
                x += (letter.kerning + parseFloat(letterspacing)) * scale;
            }

            transforms.push({
                id: letter.id,
                transform: `translate(${x} ${y + letter.y * scale - offsety}) scale(${scale}) translate(${-letter.x} ${-letter.y})`
            });
                    
            x += letter.width * scale;

            if (letter.height * scale > maxheight) maxheight = letter.height * scale;
            if (y + letter.y * scale - offsety < miny) miny = y + letter.y * scale - offsety;
            if (y + letter.y * scale - offsety + letter.height * scale > maxy) maxy = y + letter.y * scale - offsety + letter.height * scale;
            if (x > maxx) maxx = x;
        }
        y += maxheight * linespacing;
    }

    if (minx === CANVAS_WIDTH) minx = bounds.x;
    if (miny === CANVAS_HEIGHT) miny = bounds.y;

    return {
        bounds: { x: minx, y: miny, width: maxx - minx, height: maxy - miny },
        lines,
        transforms
    };
}

function distribute(items, spacing, globalbounds = { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }) {
    let height = 0;
    for (let i = 0; i < items.length; i++) {
        height += items[i].bounds.height;
        if (i > 0 && items[i].bounds.height > 0) height += spacing[i - 1];
    }

    let y = globalbounds.y + (globalbounds.height - height) / 2;

    for (let i = 0; i < items.length; i++) {
        const offset = y - items[i].bounds.y;
        let offsetx = 0;
        
        if (i > 0) {
            if (items[i].align === 'left') {
                offsetx = items[i - 1].bounds.x - items[i].bounds.x;
            } else if (items[i].align === 'right') {
                offsetx = items[i - 1].bounds.x + items[i - 1].bounds.width - (items[i].bounds.x + items[i].bounds.width);
            } else {
                offsetx = items[i - 1].bounds.x + items[i - 1].bounds.width / 2 - (items[i].bounds.x + items[i].bounds.width / 2);
            }
        }
        
        items[i].bounds.x += offsetx;
        items[i].bounds.y += offset; 

        items[i].transforms.forEach(t => {
            t.finalTransform = `translate(${offsetx} ${offset}) ${t.transform}`;
        });

        y += items[i].bounds.height;
        if (i < spacing.length) y += spacing[i];
    }
}

/**
 * Main rendering function
 */
export async function renderLogo(logoParams) {
    try {
        const logo = {
            titleScale: 1, titleBoldness: 0, titleLetterSpace: 0, titleLineSpace: 1, titleX: 0, titleY: 0, titleAlign: 'center',
            sloganScale: 1, sloganBoldness: 0, sloganLetterSpace: 0, sloganLineSpace: 1, sloganX: 0, sloganY: 0, sloganAlign: 'center',
            backgroundColor: [{hex: "transparent"}], bgTransparence: false,
            // Constraints for the wrapping algorithm
            layoutBoxWidth: 924, 
            layoutBoxHeight: 668,
            // Constraints for the final scaling
            targetBoxWidth: 720, 
            targetBoxHeight: 320,
            maxScale: 5.0, 
            ...logoParams
        };

        const result = await fetchLogoData(logo);
        if (!result || !result.svg) {
            throw new Error("Failed to retrieve valid SVG payload from render backend.");
        }

        let svgString = result.svg;
        svgString = replaceSVGLogic(svgString, result.elements, logo);

        const bbox = [];
        let prevb = false;
        for (let i = 0; i < result.elements.length; i++) {
            const b = result.elements[i];
            const bb = {
                id: b[0],
                x: parseFloat(b[1]),
                y: parseFloat(b[2]),
                width: parseFloat(b[3]),
                height: parseFloat(b[4])
            };
            if (i > 0 && prevb && bb.id.substr(0, 4) === 'path' && prevb.id.substr(0, 4) === 'path') {
                bb.kerning = bb.x - (prevb.x + prevb.width);
            }
            prevb = bb;
            bbox.push(bb);
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, 'image/svg+xml');

        // Safely set background 
        if (!logo.bgTransparence && logo.backgroundColor && logo.backgroundColor.length > 0) {
            const svgElement = doc.documentElement;
            const bgRect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
            bgRect.setAttribute("width", CANVAS_WIDTH.toString());
            bgRect.setAttribute("height", CANVAS_HEIGHT.toString());
            bgRect.setAttribute("fill", logo.backgroundColor[0].hex);
            svgElement.insertBefore(bgRect, svgElement.firstChild);
        }

        const innerWrapper = doc.querySelector('.logo-inner');
        if (innerWrapper) {
            innerWrapper.setAttribute('style', `background: ${logo.bgTransparence ? 'none' : logo.backgroundColor[0].hex};`);
        }

        // --- Styling & Colors ---
        const titleNodes = doc.querySelectorAll('#title > path, #title g > *');
        titleNodes.forEach(node => {
            if (node.tagName !== 'linearGradient' && node.tagName !== 'radialGradient') {
                node.setAttribute('stroke-width', logo.titleBoldness);
                node.setAttribute('stroke-linejoin', 'miter');
                node.setAttribute('stroke-miterlimit', '2');
            }
        });

        const titleContainer = doc.getElementById('title');
        const sloganContainer = doc.getElementById('slogan');
        if (titleContainer) titleContainer.removeAttribute('aria-label');
        if (sloganContainer) sloganContainer.removeAttribute('aria-label');

        // Process Title Colors
        if (logo.titleColor && logo.titleColor.length > 0) {
            if (logo.titleColor.length < 2) {
                const targetNodes = doc.querySelectorAll('#title > path, #title > g > *:not(linearGradient):not(radialGradient):not(.highlight)');
                targetNodes.forEach(n => {
                    n.setAttribute('fill', logo.titleColor[0].hex);
                    n.setAttribute('stroke', logo.titleColor[0].hex);
                });
                
                const highlights = doc.querySelectorAll('#title > g .highlight');
                highlights.forEach(n => {
                    n.setAttribute('opacity', (logo.titleFamily && (logo.titleFamily.includes('Shadow') || logo.titleFamily.includes('Highlight'))) ? "0" : "1");
                });
            } else {
                const titlePaths = Array.from(doc.querySelectorAll('#title > path'));
                const titleTotal = titlePaths.length - 1;
                const titleColorsSorted = [...logo.titleColor].sort((a, b) => a.location - b.location);
                
                titlePaths.forEach((path, i) => {
                    const percent = titleTotal === 0 ? 0 : i / titleTotal;
                    let a = titleColorsSorted[0], b = titleColorsSorted[1] || a;
                    
                    for (let j = 0; j < titleColorsSorted.length - 1; j++) {
                        if (titleColorsSorted[j].location <= percent && titleColorsSorted[j + 1].location >= percent) {
                            a = titleColorsSorted[j];
                            b = titleColorsSorted[j + 1];
                            break;
                        }
                    }
                    const ratio = (b.location - a.location) === 0 ? 0 : 100 * ((percent - a.location) / (b.location - a.location));
                    const hex = tinycolor.mix(tinycolor(a.hex), tinycolor(b.hex), ratio).toHexString();
                    path.setAttribute('fill', hex);
                    path.setAttribute('stroke', hex);
                });

                doc.querySelectorAll('#title g .c1').forEach(n => { n.setAttribute('fill', titleColorsSorted[0].hex); n.setAttribute('stroke', titleColorsSorted[0].hex); });
                doc.querySelectorAll('#title g .c2, #title g .c3').forEach(n => { n.setAttribute('fill', titleColorsSorted[1].hex); n.setAttribute('stroke', titleColorsSorted[1].hex); });
                if (titleColorsSorted.length > 2) {
                    doc.querySelectorAll('#title g .c3').forEach(n => { n.setAttribute('fill', titleColorsSorted[2].hex); n.setAttribute('stroke', titleColorsSorted[2].hex); });
                }

                const highlightColor = titleColorsSorted[titleColorsSorted.length - 1];
                doc.querySelectorAll('#title > g .highlight').forEach(n => n.setAttribute('opacity', highlightColor.location));

                if (logo.titleFamily && (logo.titleFamily.includes('Shadow') || logo.titleFamily.includes('Highlight'))) {
                    doc.querySelectorAll('#title > g linearGradient > stop, #title > g radialGradient > stop').forEach(stop => {
                        let styleStr = stop.getAttribute('style') || '';
                        let styleArr = styleStr.split(';').filter(s => !s.trim().startsWith('stop-color'));
                        styleArr.unshift(`stop-color:${highlightColor.hex}`);
                        stop.setAttribute('style', styleArr.join(';'));
                    });
                }

                if (logo.titleFamily && logo.titleFamily.startsWith('Brandmark') && logo.titleFamily.includes('Gradient')) {
                    if (logo.titleFamily.includes('3D')) {
                        if (titleColorsSorted.length === 2) {
                            const gradient = doc.getElementById(`3d_gradient2-${logo.id}`);
                            if (gradient) {
                                const stops = gradient.querySelectorAll('stop');
                                if(stops[0]) { stops[0].setAttribute('stop-color', titleColorsSorted[0].hex); stops[0].setAttribute('offset', `${100 * titleColorsSorted[0].location}%`); }
                                if(stops[1]) { stops[1].setAttribute('stop-color', titleColorsSorted[1].hex); stops[1].setAttribute('offset', `${100 * titleColorsSorted[1].location}%`); }
                                doc.querySelectorAll('#title > g > *:not(linearGradient):not(radialGradient)').forEach(n => {
                                    n.setAttribute('fill', `url(#3d_gradient2-${logo.id})`);
                                    n.setAttribute('stroke', `url(#3d_gradient2-${logo.id})`);
                                });
                            }
                        } else if (titleColorsSorted.length > 2) {
                            const gradient = doc.getElementById(`3d_gradient3-${logo.id}`);
                            if (gradient) {
                                const stops = gradient.querySelectorAll('stop');
                                if(stops[0]) { stops[0].setAttribute('stop-color', titleColorsSorted[0].hex); stops[0].setAttribute('offset', `${100 * titleColorsSorted[0].location}%`); }
                                if(stops[1]) { stops[1].setAttribute('stop-color', titleColorsSorted[1].hex); stops[1].setAttribute('offset', `${100 * titleColorsSorted[1].location}%`); }
                                if(stops[2]) { stops[2].setAttribute('stop-color', titleColorsSorted[2].hex); stops[2].setAttribute('offset', `${100 * titleColorsSorted[2].location}%`); }
                                doc.querySelectorAll('#title > g > *:not(linearGradient):not(radialGradient)').forEach(n => {
                                    n.setAttribute('fill', `url(#3d_gradient3-${logo.id})`);
                                    n.setAttribute('stroke', `url(#3d_gradient3-${logo.id})`);
                                });
                            }
                        }
                    } else {
                        doc.querySelectorAll('#title > g').forEach(group => {
                            const elements = Array.from(group.children).filter(el => el.tagName !== 'linearGradient' && el.tagName !== 'radialGradient');
                            const totalElements = elements.length - 1;
                            elements.forEach((el, i) => {
                                const percent = totalElements === 0 ? 0 : i / totalElements;
                                let a = titleColorsSorted[0], b = titleColorsSorted[1] || a;
                                for (let j = 0; j < titleColorsSorted.length - 1; j++) {
                                    if (titleColorsSorted[j].location <= percent && titleColorsSorted[j + 1].location >= percent) {
                                        a = titleColorsSorted[j];
                                        b = titleColorsSorted[j + 1];
                                        break;
                                    }
                                }
                                const ratio = (b.location - a.location) === 0 ? 0 : 100 * ((percent - a.location) / (b.location - a.location));
                                const hex = tinycolor.mix(tinycolor(a.hex), tinycolor(b.hex), ratio).toHexString();
                                el.setAttribute('fill', hex);
                                el.setAttribute('stroke', hex);
                            });
                        });
                    }
                }
            }
        }

        // Process Slogan Colors 
        doc.querySelectorAll('#slogan path').forEach(n => {
            n.setAttribute('stroke-width', logo.sloganBoldness);
            n.setAttribute('stroke-linejoin', 'miter');
            n.setAttribute('stroke-miterlimit', '2');
        });

        if (logo.sloganColor && logo.sloganColor.length > 0) {
            if (logo.sloganColor.length < 2) {
                doc.querySelectorAll('#slogan path').forEach(n => {
                    n.setAttribute('fill', logo.sloganColor[0].hex);
                    n.setAttribute('stroke', logo.sloganColor[0].hex);
                });
            } else {
                const sloganPaths = Array.from(doc.querySelectorAll('#slogan path'));
                const sloganTotal = sloganPaths.length - 1;
                const sloganColorsSorted = [...logo.sloganColor].sort((a, b) => a.location - b.location);
                
                sloganPaths.forEach((path, i) => {
                    const percent = sloganTotal === 0 ? 0 : i / sloganTotal;
                    let a = sloganColorsSorted[0], b = sloganColorsSorted[1] || a;
                    for (let j = 0; j < sloganColorsSorted.length - 1; j++) {
                        if (sloganColorsSorted[j].location <= percent && sloganColorsSorted[j + 1].location >= percent) {
                            a = sloganColorsSorted[j];
                            b = sloganColorsSorted[j + 1];
                            break;
                        }
                    }
                    const ratio = (b.location - a.location) === 0 ? 0 : 100 * ((percent - a.location) / (b.location - a.location));
                    const hex = tinycolor.mix(tinycolor(a.hex), tinycolor(b.hex), ratio).toHexString();
                    path.setAttribute('fill', hex);
                    path.setAttribute('stroke', hex);
                });
            }
        }

        // Safely strip display: none 
        doc.querySelectorAll('path').forEach(p => {
            p.removeAttribute('display');
            const style = p.getAttribute('style');
            if (style) p.setAttribute('style', style.replace(/display:\s*none;?/g, ''));
        });

        doc.querySelectorAll('#title > g').forEach(g => {
            g.removeAttribute('display');
            const style = g.getAttribute('style');
            if (style) g.setAttribute('style', style.replace(/display:\s*none;?/g, ''));
            g.removeAttribute('transform');
        });

        doc.querySelectorAll('#title > path').forEach(p => p.removeAttribute('transform'));

        // --- Layout (Title + Slogan, Vertically Distributed & Scaled) ---
        const layoutMarginX = (CANVAS_WIDTH - logo.layoutBoxWidth) / 2;
        const layoutMarginY = (CANVAS_HEIGHT - logo.layoutBoxHeight) / 2;

        let titleWrapObj = wrap(
            'title', logo.title, 
            { x: layoutMarginX, y: layoutMarginY, width: logo.layoutBoxWidth, height: logo.layoutBoxHeight },
            logo.titleScale, logo.titleLetterSpace, logo.titleLineSpace, logo.titleAlign, bbox, logo
        );
        titleWrapObj.align = logo.titleAlign;

        let sloganWrapObj = wrap(
            'slogan', logo.slogan, 
            { x: layoutMarginX, y: layoutMarginY, width: logo.layoutBoxWidth, height: logo.layoutBoxHeight },
            logo.sloganScale, logo.sloganLetterSpace, logo.sloganLineSpace, logo.sloganAlign, bbox, logo
        );
        
        // Force Flush Slogan Scaling (If single line)
        if (sloganWrapObj.lines.length === 1 && titleWrapObj.bounds.width > 0 && sloganWrapObj.bounds.width > 0) {
            const scaleMultiplier = titleWrapObj.bounds.width / sloganWrapObj.bounds.width;
            logo.sloganScale = logo.sloganScale * scaleMultiplier;
            
            // Re-wrap the slogan with the calculated flush scale
            sloganWrapObj = wrap(
                'slogan', logo.slogan, 
                { x: layoutMarginX, y: layoutMarginY, width: logo.layoutBoxWidth, height: logo.layoutBoxHeight },
                logo.sloganScale, logo.sloganLetterSpace, logo.sloganLineSpace, logo.sloganAlign, bbox, logo
            );
        }
        
        sloganWrapObj.align = logo.sloganAlign;

        distribute([titleWrapObj, sloganWrapObj], [18 * logo.sloganLineSpace]);

        [...titleWrapObj.transforms, ...sloganWrapObj.transforms].forEach(tData => {
            const el = doc.getElementById(tData.id);
            if (el) el.setAttribute('transform', tData.finalTransform || tData.transform);
        });

        let globalMinX = Infinity, globalMinY = Infinity;
        let globalMaxX = -Infinity, globalMaxY = -Infinity;

        [titleWrapObj, sloganWrapObj].forEach(obj => {
            if (obj.bounds.width > 0 && obj.bounds.height > 0) {
                globalMinX = Math.min(globalMinX, obj.bounds.x);
                globalMinY = Math.min(globalMinY, obj.bounds.y);
                globalMaxX = Math.max(globalMaxX, obj.bounds.x + obj.bounds.width);
                globalMaxY = Math.max(globalMaxY, obj.bounds.y + obj.bounds.height);
            }
        });

        if (globalMinX === Infinity) {
            globalMinX = CANVAS_CENTER_X; globalMaxX = CANVAS_CENTER_X;
            globalMinY = CANVAS_CENTER_Y; globalMaxY = CANVAS_CENTER_Y;
        }

        const currentWidth = globalMaxX - globalMinX;
        const currentHeight = globalMaxY - globalMinY;
        const currentCenterX = globalMinX + currentWidth / 2;
        const currentCenterY = globalMinY + currentHeight / 2;

        let scale = 1;
        if (currentWidth > 0 && currentHeight > 0) {
            const scaleX = logo.targetBoxWidth / currentWidth;
            const scaleY = logo.targetBoxHeight / currentHeight;
            scale = Math.min(scaleX, scaleY);
        }
        
        scale = Math.min(scale, logo.maxScale);

        const translateX = CANVAS_CENTER_X - (currentCenterX * scale);
        const translateY = CANVAS_CENTER_Y - (currentCenterY * scale);

        const logoCenter = doc.getElementById('logo-center');
        if (logoCenter) {
            logoCenter.setAttribute('transform', `translate(${translateX} ${translateY}) scale(${scale})`);
        }

        if (titleContainer) titleContainer.setAttribute('transform', `translate(${logo.titleX} ${logo.titleY})`);
        if (sloganContainer) sloganContainer.setAttribute('transform', `translate(${logo.sloganX} ${logo.sloganY})`);

        // Safely hide unused layout elements
        ['icon', 'icon_container', 'container'].forEach(id => {
            const el = doc.getElementById(id);
            if (el) el.setAttribute('display', 'none');
        });

        return new XMLSerializer().serializeToString(doc);

    } catch (error) {
        console.error("[LogoRenderer] Critical render failure! State dump:", {
            error: error.message,
            stack: error.stack,
            params: logoParams
        });
        throw error;
    }
}