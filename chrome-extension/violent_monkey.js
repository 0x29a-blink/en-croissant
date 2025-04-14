// ==UserScript==
// @name        Chess.com Robust FEN Sender
// @namespace   Violentmonkey Scripts
// @match       *://*.chess.com/game/*
// @match       *://*.chess.com/play/online*
// @match       *://*.chess.com/live*
// @match       *://*.chess.com/variants/*
// @grant       GM_xmlhttpRequest
// @version     3.0
// @author      AI Assistant
// @description Sends a FEN from chess.com to a local backend, handling all board orientations correctly.
// @connect     localhost
// @connect     127.0.0.1
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const BACKEND_URL = 'http://127.0.0.1:3030/fen';
    const MOVE_LIST_SELECTOR = '.moves-moves-list div.moves-table';
    const MOVE_NUMBER_SELECTOR = 'div[id^="full-move-nr_"]';
    const BOARD_SELECTOR = '.TheBoard-layers';
    const PIECE_SELECTOR = '.piece[data-piece][style*="translate"]';
    const PLAYER_BOX_SELECTOR = '.playerbox-component';
    const DEBOUNCE_DELAY_MS = 750;

    // --- WebSocket Configuration ---
    const WS_URL = 'ws://127.0.0.1:3030/ws';
    let ws;

    // --- Analysis Visualization Configuration ---
    const ARROW_COLORS = {
        singleEngine: [
            '#00FF00', // Best move (bright green)
            '#80FF00', // 2nd best (yellow-green)
            '#FFFF00', // 3rd best (yellow)
            '#FF8000', // 4th best (orange)
            '#FF0000'  // 5th best (red)
        ],
        engines: {
            // Default colors for common engines - can be expanded
            'stockfish': '#3692E7',  // blue
            'lc0': '#E736C5',        // pink
            'komodo': '#8DE736',     // green
            'default': '#E7A336'     // orange (for any other engine)
        }
    };
    const ARROW_WIDTH = 8;      // Width of the arrows in pixels
    const ARROW_OPACITY = 0.8;  // Opacity of the arrows (0-1)
    const SHOW_LABELS = true;   // Whether to show move rank labels

    // Storage for active analysis
    let currentAnalysis = {}; // Format: { engineId: [{ move, score, rank }, ...], ... }
    let analysisOverlay;      // The SVG overlay for drawing arrows
    let labelContainer;       // Container for text labels

    function connectWebSocket() {
        console.log('[WebSocket] ====== INITIALIZING WEBSOCKET CONNECTION ======');
        console.log('[WebSocket] Creating new WebSocket connection to:', WS_URL);
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('[WebSocket] ====== WEBSOCKET CONNECTION ESTABLISHED ======');
            console.log('[WebSocket] Connection opened successfully');
            console.log('[WebSocket] WebSocket readyState:', ws.readyState);
            console.log('[WebSocket] WebSocket protocol:', ws.protocol);
            console.log('[WebSocket] WebSocket extensions:', ws.extensions);
        };

        ws.onmessage = (event) => {
            console.log('[WebSocket] ====== NEW MESSAGE RECEIVED ======');
            console.log('[WebSocket] Raw message data:', event.data);
            console.log('[WebSocket] WebSocket readyState:', ws.readyState);
            
            try {
                const data = JSON.parse(event.data);
                console.log('[WebSocket] Parsed JSON data:', data);
                
                // Handle connection status
                if (data.status === 'connected') {
                    console.log('[WebSocket] Connection status message received');
                    console.log('[WebSocket] Connection confirmed by server');
                    return;
                }
                
                // Handle engine visualization update
                if (data.engineId === "board_visualization" && data.analysis) {
                    console.log('[WebSocket] Board visualization message received');
                    console.log('[WebSocket] Analysis data:', data.analysis);
                    
                    // Convert analysis format to visualization format
                    const visualization = {
                        totalEngines: 1,
                        enabledEngines: 1,
                        engineLines: {
                            "0": {
                                engineIndex: 0,
                                bestWinChance: data.analysis[0]?.score || 0,
                                variations: [{
                                    variationIndex: 0,
                                    winChance: data.analysis[0]?.score || 0,
                                    arrows: data.analysis.map(item => {
                                        console.log('[WebSocket] Processing analysis item:', item);
                                        const [from, to] = item.move.split('-');
                                        const arrow = {
                                            from,
                                            to,
                                            color: ARROW_COLORS.singleEngine[Math.min(item.rank - 1, ARROW_COLORS.singleEngine.length - 1)],
                                            lineWidth: ARROW_WIDTH,
                                            isMainLine: item.rank === 1,
                                            moveNumber: item.rank
                                        };
                                        console.log('[WebSocket] Created arrow:', arrow);
                                        return arrow;
                                    })
                                }]
                            }
                        },
                        finalShapes: data.analysis.map(item => {
                            console.log('[WebSocket] Processing final shape:', item);
                            const [from, to] = item.move.split('-');
                            const shape = {
                                from,
                                to,
                                color: ARROW_COLORS.singleEngine[Math.min(item.rank - 1, ARROW_COLORS.singleEngine.length - 1)],
                                lineWidth: ARROW_WIDTH,
                                moveNumber: item.rank
                            };
                            console.log('[WebSocket] Created shape:', shape);
                            return shape;
                        })
                    };
                    
                    console.log('[WebSocket] Converted visualization data:', visualization);
                    console.log('[WebSocket] Calling renderEngineVisualization...');
                    renderEngineVisualization(visualization);
                    console.log('[WebSocket] ====== MESSAGE PROCESSING COMPLETE ======');
                } else {
                    console.log('[WebSocket] Unhandled message format:', data);
                    console.log('[WebSocket] Expected engineId: "board_visualization" and analysis array');
                    console.log('[WebSocket] ====== MESSAGE PROCESSING COMPLETE ======');
                }
            } catch (e) {
                console.error('[WebSocket] Failed to parse message:', e);
                console.error('[WebSocket] Raw message that failed to parse:', event.data);
                console.log('[WebSocket] ====== MESSAGE PROCESSING FAILED ======');
            }
        };

        ws.onclose = (event) => {
            console.log('[WebSocket] ====== WEBSOCKET CONNECTION CLOSED ======');
            console.log('[WebSocket] Close event:', event);
            console.log('[WebSocket] Code:', event.code);
            console.log('[WebSocket] Reason:', event.reason);
            console.log('[WebSocket] Was clean:', event.wasClean);
            clearAnalysisVisuals();
            console.log('[WebSocket] Reconnecting in 5 seconds...');
            setTimeout(connectWebSocket, 5000);
        };

        ws.onerror = (error) => {
            console.error('[WebSocket] ====== WEBSOCKET ERROR ======');
            console.error('[WebSocket] Error event:', error);
            console.error('[WebSocket] WebSocket readyState:', ws.readyState);
        };
    }

    // Initialize WebSocket connection
    connectWebSocket();

    /**
     * Creates the SVG overlay for drawing arrows on the board
     */
    function createAnalysisOverlay() {
        if (analysisOverlay) return; // Already created
        
        const boardElement = document.querySelector('.TheBoard-layers');
        if (!boardElement) return;
        
        // Create SVG overlay
        analysisOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        analysisOverlay.setAttribute('class', 'analysis-arrows-overlay');
        analysisOverlay.style.position = 'absolute';
        analysisOverlay.style.top = '0';
        analysisOverlay.style.left = '0';
        analysisOverlay.style.width = '100%';
        analysisOverlay.style.height = '100%';
        analysisOverlay.style.pointerEvents = 'none';
        analysisOverlay.style.zIndex = '5'; // Above pieces but below hover effects
        boardElement.appendChild(analysisOverlay);
        
        // Create label container
        labelContainer = document.createElement('div');
        labelContainer.setAttribute('class', 'analysis-labels-container');
        labelContainer.style.position = 'absolute';
        labelContainer.style.top = '0';
        labelContainer.style.left = '0';
        labelContainer.style.width = '100%';
        labelContainer.style.height = '100%';
        labelContainer.style.pointerEvents = 'none';
        labelContainer.style.zIndex = '6';
        boardElement.appendChild(labelContainer);
    }

    /**
     * Clears all analysis visualizations from the board
     */
    function clearAnalysisVisuals() {
        if (analysisOverlay) {
            while (analysisOverlay.firstChild) {
                analysisOverlay.removeChild(analysisOverlay.firstChild);
            }
        }
        
        if (labelContainer) {
            while (labelContainer.firstChild) {
                labelContainer.removeChild(labelContainer.firstChild);
            }
        }
    }

    /**
     * Draws arrows on the board based on current analysis
     */
    function drawAnalysisOnBoard() {
        // Ensure we have the overlay
        createAnalysisOverlay();
        
        // Clear previous drawings
        clearAnalysisVisuals();
        
        // Get all active engines
        const activeEngines = Object.keys(currentAnalysis);
        if (activeEngines.length === 0) return;
        
        // Get the board dimensions for calculations
        const boardDimensions = getBoardDimensions();
        if (!boardDimensions) return;
        
        const { playingAsBlack } = determinePlayerColor();
        
        if (activeEngines.length === 1) {
            // Single engine mode: gradient color
            const engineId = activeEngines[0];
            const analysis = currentAnalysis[engineId];
            
            if (!analysis || analysis.length === 0) return;
            
            analysis.forEach((line, index) => {
                if (!line.move) return;
                
                const color = ARROW_COLORS.singleEngine[Math.min(index, ARROW_COLORS.singleEngine.length - 1)];
                const from = line.move.substring(0, 2);
                const to = line.move.substring(2, 4);
                
                drawArrow(from, to, color, line.rank, boardDimensions, playingAsBlack);
            });
        } else {
            // Multi-engine mode: one color per engine
            activeEngines.forEach(engineId => {
                const analysis = currentAnalysis[engineId];
                if (!analysis || analysis.length === 0) return;
                
                // Get the color for this engine
                const color = ARROW_COLORS.engines[engineId.toLowerCase()] || ARROW_COLORS.engines.default;
                
                analysis.forEach(line => {
                    if (!line.move) return;
                    
                    const from = line.move.substring(0, 2);
                    const to = line.move.substring(2, 4);
                    
                    drawArrow(from, to, color, line.rank, boardDimensions, playingAsBlack);
                });
            });
        }
    }

    /**
     * Draws an arrow on the board
     * @param {string} from - Starting square (e.g., "e2")
     * @param {string} to - Ending square (e.g., "e4")
     * @param {string} color - Arrow color in hex format
     * @param {number} rank - Move rank for labeling
     * @param {object} dimensions - Board dimensions
     * @param {boolean} playingAsBlack - Whether we're playing as black
     */
    function drawArrow(from, to, color, rank, dimensions, playingAsBlack) {
        const { squareSize } = dimensions;
        
        // Convert chess notation to coordinates
        const fromCoords = getSquareCoordinates(from, squareSize, playingAsBlack);
        const toCoords = getSquareCoordinates(to, squareSize, playingAsBlack);
        
        if (!fromCoords || !toCoords) return;
        
        // Create arrow path
        const arrowPath = createArrowPath(fromCoords, toCoords, ARROW_WIDTH);
        
        // Create SVG path element
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', arrowPath);
        path.setAttribute('fill', color);
        path.setAttribute('stroke', 'none');
        path.setAttribute('opacity', ARROW_OPACITY);
        analysisOverlay.appendChild(path);
        
        // Add label if enabled
        if (SHOW_LABELS && rank) {
            const label = document.createElement('div');
            label.textContent = rank;
            label.style.position = 'absolute';
            label.style.left = `${toCoords.x - 6}px`;
            label.style.top = `${toCoords.y - 6}px`;
            label.style.width = '12px';
            label.style.height = '12px';
            label.style.borderRadius = '50%';
            label.style.backgroundColor = color;
            label.style.color = 'white';
            label.style.fontSize = '10px';
            label.style.fontWeight = 'bold';
            label.style.display = 'flex';
            label.style.justifyContent = 'center';
            label.style.alignItems = 'center';
            label.style.zIndex = '7';
            labelContainer.appendChild(label);
        }
    }

    /**
     * Creates an SVG path for an arrow
     * @param {object} from - Starting coordinates {x, y}
     * @param {object} to - Ending coordinates {x, y}
     * @param {number} width - Arrow width
     * @returns {string} SVG path definition
     */
    function createArrowPath(from, to, width) {
        // Calculate arrow direction
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const angle = Math.atan2(dy, dx);
        
        // Calculate arrow length (slightly shorter than full distance)
        const length = Math.sqrt(dx * dx + dy * dy) * 0.75;
        
        // Calculate end point (backing off from target center)
        const endX = from.x + Math.cos(angle) * length;
        const endY = from.y + Math.sin(angle) * length;
        
        // Calculate arrowhead points
        const headSize = width * 2;
        const arrowhead1X = endX - headSize * Math.cos(angle - Math.PI/6);
        const arrowhead1Y = endY - headSize * Math.sin(angle - Math.PI/6);
        const arrowhead2X = endX - headSize * Math.cos(angle + Math.PI/6);
        const arrowhead2Y = endY - headSize * Math.sin(angle + Math.PI/6);
        
        // Calculate shaft points
        const shaftWidth = width / 2;
        const shaftAngle = angle + Math.PI/2;
        
        const shaft1X = from.x + shaftWidth * Math.cos(shaftAngle);
        const shaft1Y = from.y + shaftWidth * Math.sin(shaftAngle);
        const shaft2X = from.x - shaftWidth * Math.cos(shaftAngle);
        const shaft2Y = from.y - shaftWidth * Math.sin(shaftAngle);
        
        const shaft3X = endX - shaftWidth * Math.cos(shaftAngle);
        const shaft3Y = endY - shaftWidth * Math.sin(shaftAngle);
        const shaft4X = endX + shaftWidth * Math.cos(shaftAngle);
        const shaft4Y = endY + shaftWidth * Math.sin(shaftAngle);
        
        // Build SVG path
        return `M ${shaft1X} ${shaft1Y} ` +
               `L ${shaft4X} ${shaft4Y} ` +
               `L ${arrowhead1X} ${arrowhead1Y} ` +
               `L ${endX} ${endY} ` +
               `L ${arrowhead2X} ${arrowhead2Y} ` +
               `L ${shaft3X} ${shaft3Y} ` +
               `L ${shaft2X} ${shaft2Y} Z`;
    }

    /**
     * Converts chess square notation to coordinates
     * @param {string} square - Chess square (e.g., "e4")
     * @param {number} squareSize - Size of a board square in pixels
     * @param {boolean} playingAsBlack - Whether board is flipped (playing as black)
     * @returns {object|null} Coordinates {x, y} or null if invalid
     */
    function getSquareCoordinates(square, squareSize, playingAsBlack) {
        if (!square || square.length !== 2) return null;
        
        const file = square.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7 for a-h
        const rank = 8 - parseInt(square[1], 10); // 0-7 for 8-1
        
        if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
        
        // If playing as black, the board is flipped
        const adjustedFile = playingAsBlack ? 7 - file : file;
        const adjustedRank = playingAsBlack ? 7 - rank : rank;
        
        // Calculate pixel coordinates (center of the square)
        const x = (adjustedFile + 0.5) * squareSize;
        const y = (adjustedRank + 0.5) * squareSize;
        
        return { x, y };
    }

    // --- State ---
    let currentFen = '';
    let debounceTimer = null;
    let observer = null;
    let cachedPlayerColor = null;
    let recalculateButton = null;
    
    /**
     * Creates a button for recalculating FEN and adds it to the Chess.com UI
     */
    function createRecalculateButton() {
        // Check if button already exists
        if (recalculateButton !== null) return;
        
        // Create button element
        recalculateButton = document.createElement('button');
        recalculateButton.textContent = '↻ Recalculate FEN';
        recalculateButton.title = 'Force recalculation of board orientation and FEN';
        
        // Style the button to blend with Chess.com's UI
        recalculateButton.style.position = 'fixed';
        recalculateButton.style.bottom = '10px';
        recalculateButton.style.right = '10px';
        recalculateButton.style.zIndex = '9999';
        recalculateButton.style.padding = '5px 10px';
        recalculateButton.style.fontSize = '12px';
        recalculateButton.style.fontFamily = 'Arial, sans-serif';
        recalculateButton.style.backgroundColor = '#30844c'; // Chess.com green
        recalculateButton.style.color = 'white';
        recalculateButton.style.border = 'none';
        recalculateButton.style.borderRadius = '4px';
        recalculateButton.style.cursor = 'pointer';
        recalculateButton.style.opacity = '0.8';
        recalculateButton.style.transition = 'opacity 0.3s';
        
        // Add hover effect
        recalculateButton.addEventListener('mouseover', () => {
            recalculateButton.style.opacity = '1';
        });
        
        recalculateButton.addEventListener('mouseout', () => {
            recalculateButton.style.opacity = '0.8';
        });
        
        // Add click event listener
        recalculateButton.addEventListener('click', () => {
            resetCache();
        });
        
        // Add button to page
        document.body.appendChild(recalculateButton);
        console.log('[FEN Sender] Recalculate button added to page');
    }
    
    /**
     * Resets all cached values and forces recalculation
     */
    function resetCache() {
        cachedPlayerColor = null;
        currentFen = '';
        console.log('[FEN Sender] Cache cleared - forcing recalculation');
        calculateAndSendFEN();
    }
    
    console.log('[FEN Sender] Script starting (v3.0 - Robust FEN handling)...');

    /**
     * Gets the board dimensions and square size.
     * @returns {{boardSize: number, squareSize: number} | null}
     */
    function getBoardDimensions() {
        const boardContainer = document.querySelector(BOARD_SELECTOR);
        if (!boardContainer) {
            console.error('[FEN Sender] Board container not found.');
            return null;
        }
        
        // Get the actual board element that contains the pieces
        const boardElement = boardContainer.querySelector('.board') || boardContainer;
        if (!boardElement) {
            console.error('[FEN Sender] Board element not found.');
            return null;
        }
        
        // Get the computed style to handle any transforms or scaling
        const style = window.getComputedStyle(boardElement);
        const width = parseFloat(style.width);
        const height = parseFloat(style.height);
        
        if (!width || !height || width <= 0 || height <= 0) {
            console.error('[FEN Sender] Board element has invalid dimensions:', { width, height });
            return null;
        }
        
        // Calculate square size based on the smaller dimension to ensure it fits
        const squareSize = Math.min(width, height) / 8;
        
        console.log('[FEN Sender] Board dimensions:', { width, height, squareSize });
        return { 
            boardSize: Math.min(width, height),
            squareSize 
        };
    }

    /**
     * Determines player color based on multiple methods with fallbacks.
     * @returns {{playingAsBlack: boolean}} Object indicating if the player is playing as black
     */
    function determinePlayerColor() {
        // If already cached, return the cached value
        if (cachedPlayerColor !== null) {
            return { playingAsBlack: cachedPlayerColor };
        }
        
        let playingAsBlack = false;
        let confidenceScore = 0; // Track confidence in our determination
        
        // Method 1: Most reliable - Check piece colors at the bottom of the board
        const allPieces = document.querySelectorAll(PIECE_SELECTOR);
        const bottomPieces = [];
        const topPieces = [];
        
        // Collect pieces from top and bottom of board
        allPieces.forEach(piece => {
            const transform = piece.style.transform;
            const match = transform.match(/translate\(\s*(-?\d+(\.\d+)?)px\s*,\s*(-?\d+(\.\d+)?)px\s*\)/);
            if (match) {
                const y = parseFloat(match[3]);
                // Bottom rows (high y values)
                if (y > 600) {
                    bottomPieces.push(piece);
                }
                // Top rows (low y values)
                else if (y < 200) {
                    topPieces.push(piece);
                }
            }
        });
        
        if (bottomPieces.length >= 8) { // We need enough pieces for a reliable determination
            const blackPiecesAtBottom = bottomPieces.filter(p => p.dataset.color === "6").length;
            const whitePiecesAtBottom = bottomPieces.filter(p => p.dataset.color === "5").length;
            
            // If most pieces at bottom are black (color "6"), we're playing as black
            if (blackPiecesAtBottom > whitePiecesAtBottom) {
                playingAsBlack = true;
                confidenceScore += 3; // High confidence
                console.log(`[FEN Sender] Found ${blackPiecesAtBottom}/${bottomPieces.length} black pieces at bottom - strongly indicates playing as BLACK`);
            } else if (whitePiecesAtBottom > blackPiecesAtBottom) {
                playingAsBlack = false;
                confidenceScore += 3; // High confidence
                console.log(`[FEN Sender] Found ${whitePiecesAtBottom}/${bottomPieces.length} white pieces at bottom - strongly indicates playing as WHITE`);
            }
        }
        
        // Method 2: Check if coordinates match black's perspective
        // If the a-h labels are at the bottom, user is likely viewing from black's perspective
        const coordLabels = document.querySelectorAll('.Coordinates-component text');
        if (coordLabels.length > 0) {
            // Check if there's an 'a' label near the bottom of the board
            const hasBottomFileA = Array.from(coordLabels).some(label => {
                const text = label.textContent;
                const y = parseFloat(label.getAttribute('y'));
                return text === 'a' && y > 7.5; // 'a' near bottom of board indicates black perspective
            });
            
            if (hasBottomFileA) {
                if (!playingAsBlack) { // This conflicts with our previous determination
                    console.log('[FEN Sender] Found \'a\' coordinate at bottom - indicates BLACK perspective (contradicts previous determination)');
                    confidenceScore -= 1;
                } else {
                    console.log('[FEN Sender] Found \'a\' coordinate at bottom - confirms BLACK perspective');
                    confidenceScore += 1;
                }
                playingAsBlack = true;
            }
        }
        
        // Method 3: Check bottom player's clock color
        const bottomClock = document.querySelector('.playerbox-bottom .clock-component');
        if (bottomClock) {
            const clockStyle = bottomClock.getAttribute('style') || '';
            
            if (clockStyle.includes('background-color')) {
                const rgbMatch = clockStyle.match(/background-color:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
                if (rgbMatch) {
                    const r = parseInt(rgbMatch[1], 10);
                    const g = parseInt(rgbMatch[2], 10);
                    const b = parseInt(rgbMatch[3], 10);
                    
                    // Chess.com uses darker colors for black player clocks
                    // Dark colors have luminance < 0.5
                    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                    const clockIndicatesBlack = luminance < 0.5;
                    
                    if (clockIndicatesBlack !== playingAsBlack && confidenceScore > 0) {
                        console.log(`[FEN Sender] Clock color luminance (${luminance.toFixed(2)}) contradicts piece position detection`);
                    } else {
                        console.log(`[FEN Sender] Clock color: rgb(${r},${g},${b}), luminance: ${luminance.toFixed(2)}, indicates playing as ${clockIndicatesBlack ? 'BLACK' : 'WHITE'}`);
                        playingAsBlack = clockIndicatesBlack;
                        confidenceScore += 2;
                    }
                }
            }
        }
        
        // Method 4: Check player tags as fallback
        const bottomPlayerBox = document.querySelector('.playerbox-bottom');
        if (bottomPlayerBox) {
            if (bottomPlayerBox.querySelector('.player-tag.player-black')) {
                if (!playingAsBlack && confidenceScore > 1) {
                    console.log('[FEN Sender] Found black player tag at bottom, but contradicts higher confidence indicators');
                } else {
                    console.log('[FEN Sender] Found black player tag at bottom');
                    playingAsBlack = true;
                    confidenceScore += 1;
                }
            }
            else if (bottomPlayerBox.querySelector('.player-tag.player-white')) {
                if (playingAsBlack && confidenceScore > 1) {
                    console.log('[FEN Sender] Found white player tag at bottom, but contradicts higher confidence indicators');
                } else {
                    console.log('[FEN Sender] Found white player tag at bottom');
                    playingAsBlack = false;
                    confidenceScore += 1;
                }
            }
        }
        
        // Verify detection against piece colors when cached is null
        if (topPieces.length >= 8 && bottomPieces.length >= 8) {
            // If we're playing as black, top pieces should be mostly white
            // If we're playing as white, top pieces should be mostly black
            const whitePiecesAtTop = topPieces.filter(p => p.dataset.color === "5").length;
            const blackPiecesAtTop = topPieces.filter(p => p.dataset.color === "6").length;
            
            const expectedTopColor = playingAsBlack ? "5" : "6"; // If black perspective, white pieces at top
            const expectedTopCount = playingAsBlack ? whitePiecesAtTop : blackPiecesAtTop;
            const totalTop = topPieces.length;
            
            if (expectedTopCount < totalTop / 2) {
                console.log(`[FEN Sender] ⚠️ DETECTION ERROR: Top pieces don't match expected perspective. Forcibly INVERTING detection!`);
                playingAsBlack = !playingAsBlack;
            } else {
                console.log(`[FEN Sender] ✓ Verified: Top pieces match expected perspective for ${playingAsBlack ? 'BLACK' : 'WHITE'} player`);
            }
        }
        
        // Override all detection methods if a special class or attribute directly indicates perspective
        const boardContainer = document.querySelector('.TheBoard-layers, #board-layout-main');
        if (boardContainer) {
            // Chess.com sometimes adds classes to indicate perspective
            if (boardContainer.classList.contains('black-perspective') || 
                boardContainer.getAttribute('data-perspective') === 'black') {
                console.log('[FEN Sender] Found definitive black perspective indicator on board');
                playingAsBlack = true;
                confidenceScore = 10; // Highest confidence
            }
            else if (boardContainer.classList.contains('white-perspective') || 
                    boardContainer.getAttribute('data-perspective') === 'white') {
                console.log('[FEN Sender] Found definitive white perspective indicator on board');
                playingAsBlack = false;
                confidenceScore = 10; // Highest confidence
            }
        }
        
        // Last resort check: see if there are ranks/files labeled at the board edges
        // If rank 8 is at top, it's from white's perspective. If rank 1 is at top, it's from black's.
        const rank1Indicator = document.querySelector('text[font-size="0.23"]:not([x]):not([y])');
        if (rank1Indicator && rank1Indicator.textContent === '1' && 
            rank1Indicator.parentElement.querySelector('text[content="8"]')) {
            if (playingAsBlack) {
                console.log('[FEN Sender] Found rank indicators contradicting current detection');
            }
        }
        
        // Force black-detection if all else fails but clear visual indicators are present
        const bottomUser = document.querySelector('.playerbox-bottom .playerbox-username');
        const topUser = document.querySelector('.playerbox-top .playerbox-username');
        if (bottomUser && topUser && confidenceScore === 0) {
            // If bottom user matches our logged-in username, this is our perspective
            // Simple check: see if bottom avatar has dark border
            const bottomAvatar = document.querySelector('.playerbox-bottom .playerbox-avatar img');
            if (bottomAvatar && bottomAvatar.getAttribute('style')?.includes('border: 0.2rem solid rgb(91, 88, 87)')) {
                playingAsBlack = true;
                console.log('[FEN Sender] Last resort detection: Found dark border on bottom avatar - likely BLACK');
            }
        }
        
        // Cache result for consistency
        cachedPlayerColor = playingAsBlack;
        console.log(`[FEN Sender] Final player color determination: ${playingAsBlack ? 'BLACK' : 'WHITE'} (confidence: ${confidenceScore}, cached)`);
        
        return { playingAsBlack };
    }

    /**
     * Maps pixel coordinates to algebraic notation.
     * @param {number} x - Pixel X coordinate
     * @param {number} y - Pixel Y coordinate
     * @param {number} squareSize - Square size in pixels
     * @returns {string|null} Algebraic notation (e.g., "e4") or null
     */
    function mapCoordsToSquare(x, y, squareSize) {
        if (squareSize <= 0) return null;
        
        // Calculate file and rank indices (0-7)
        const fileIndex = Math.round(x / squareSize);
        const rankIndex = 7 - Math.round(y / squareSize);
        
        if (fileIndex < 0 || fileIndex > 7 || rankIndex < 0 || rankIndex > 7) {
            return null;
        }
        
        const file = String.fromCharCode('a'.charCodeAt(0) + fileIndex);
        const rank = rankIndex + 1;
        
        return `${file}${rank}`;
    }
    
    /**
     * Generates a FEN string representing the current board position.
     * @returns {string|null} FEN string or null on error
     */
    function generateFEN() {
        // Get board dimensions
        const dimensions = getBoardDimensions();
        if (!dimensions) return null;
        const { squareSize } = dimensions;
        
        // Get player color
        const { playingAsBlack } = determinePlayerColor();
        
        // Get pieces
        const pieces = document.querySelectorAll(PIECE_SELECTOR);
        if (pieces.length === 0) return null;
        
        // Initialize 8x8 board representation
        const board = Array(8).fill().map(() => Array(8).fill(null));
        
        // Parse piece transforms to place on board
        const transformRegex = /translate\(\s*(-?\d+(\.\d+)?)px\s*,\s*(-?\d+(\.\d+)?)px\s*\)/;
        
        pieces.forEach(piece => {
            const pieceType = piece.dataset.piece;
            const pieceColor = piece.dataset.color;
            const transform = piece.style.transform;
            
            if (!pieceType || !pieceColor || !transform) return;
            
            const match = transform.match(transformRegex);
            if (!match) return;
            
            const x = parseFloat(match[1]);
            const y = parseFloat(match[3]);
            
            const square = mapCoordsToSquare(x, y, squareSize);
            if (!square) return;
            
            const fileIndex = square.charCodeAt(0) - 'a'.charCodeAt(0);
            const rankIndex = 8 - parseInt(square[1], 10);
            
            if (rankIndex < 0 || rankIndex > 7 || fileIndex < 0 || fileIndex > 7) return;
            
            // Map piece color - "5" is white, "6" is black
            let fenChar;
            if (pieceColor === '5') {
                fenChar = pieceType.toUpperCase(); // White pieces
            } else {
                fenChar = pieceType.toLowerCase(); // Black pieces
            }
            
            // Place piece on board according to standard FEN orientation
            // FEN always represents the board from white's perspective (8th rank at top, 1st rank at bottom)
            // So we need to properly map visual positions to standard FEN positions
            if (playingAsBlack) {
                // When playing as black, we need to flip BOTH horizontally and vertically
                // This places pieces at the correct FEN ranks/files regardless of our view
                board[7 - rankIndex][7 - fileIndex] = fenChar;
            } else {
                // Standard orientation for white perspective
                board[rankIndex][fileIndex] = fenChar;
            }
        });
        
        // Convert board array to FEN string - always starting with rank 8 (top) to rank 1 (bottom)
        // Standard FEN notation is always top-to-bottom regardless of player's perspective
        let fenPiecePlacement = '';
        // Start with rank 8 (index 0) and end with rank 1 (index 7)
        for (let r = 0; r < 8; r++) {
            let emptyCount = 0;
            for (let f = 0; f < 8; f++) {
                if (board[r][f]) {
                    if (emptyCount > 0) {
                        fenPiecePlacement += emptyCount;
                        emptyCount = 0;
                    }
                    fenPiecePlacement += board[r][f];
                } else {
                    emptyCount++;
                }
            }
            if (emptyCount > 0) {
                fenPiecePlacement += emptyCount;
            }
            if (r < 7) {
                fenPiecePlacement += '/';
            }
        }
        
        // Determine active color
        const activeColor = determineActiveColor();
        
        // Use placeholders for castling, en passant, halfmove
        const castling = '-';
        const enPassant = '-';
        const halfMove = '0';
        
        // Get move number
        const moveNumber = determineMoveNumber();
        
        // Combine all parts to create the FEN
        return `${fenPiecePlacement} ${activeColor} ${castling} ${enPassant} ${halfMove} ${moveNumber}`;
    }
    
    /**
     * Determines whose turn it is to move.
     * @returns {string} 'w' for white, 'b' for black
     */
    function determineActiveColor() {
        // Check for new game with no moves
        const moveListItems = document.querySelectorAll('.moves-table-row');
        const isNewGame = moveListItems.length <= 1;
        
        if (isNewGame && document.querySelector('.moves-table-cell .moves-move:empty')) {
            return 'w'; // New game always starts with white
        }
        
        // Get player color
        const { playingAsBlack } = determinePlayerColor();
        
        // Clock selectors depend on who's playing
        const whiteClockSelector = playingAsBlack ? '.playerbox-top .clock-component' : '.playerbox-bottom .clock-component';
        const blackClockSelector = playingAsBlack ? '.playerbox-bottom .clock-component' : '.playerbox-top .clock-component';
        
        const whiteClock = document.querySelector(whiteClockSelector);
        const blackClock = document.querySelector(blackClockSelector);
        
        // Check for active indicators
        let whiteActive = false;
        let blackActive = false;
        
        // Check for "running" class
        if (whiteClock?.classList.contains('running')) {
            whiteActive = true;
        }
        if (blackClock?.classList.contains('running')) {
            blackActive = true;
        }
        
        // Check for brightness style
        if (!whiteActive && whiteClock) {
            const whiteStyle = whiteClock.getAttribute('style') || '';
            if (whiteStyle.includes('brightness(100%)')) {
                whiteActive = true;
            }
        }
        
        if (!blackActive && blackClock) {
            const blackStyle = blackClock.getAttribute('style') || '';
            if (blackStyle.includes('brightness(100%)')) {
                blackActive = true;
            }
        }
        
        // Compare brightness values
        if (!whiteActive && !blackActive && whiteClock && blackClock) {
            const whiteStyle = whiteClock.getAttribute('style') || '';
            const blackStyle = blackClock.getAttribute('style') || '';
            
            const whiteFilter = whiteStyle.match(/brightness\((\d+)%\)/);
            const blackFilter = blackStyle.match(/brightness\((\d+)%\)/);
            
            if (whiteFilter && blackFilter) {
                const whiteBrightness = parseInt(whiteFilter[1], 10);
                const blackBrightness = parseInt(blackFilter[1], 10);
                
                if (whiteBrightness > blackBrightness) {
                    whiteActive = true;
                } else if (blackBrightness > whiteBrightness) {
                    blackActive = true;
                }
            }
        }
        
        // If no clock indicators found, check move list
        if (!whiteActive && !blackActive) {
            const lastMoveCell = document.querySelector('.moves-table-cell.moves-move:last-child:not(:empty)');
            if (lastMoveCell) {
                const moveIndex = Array.from(document.querySelectorAll('.moves-table-cell.moves-move')).indexOf(lastMoveCell);
                if (moveIndex !== -1) {
                    return moveIndex % 2 === 0 ? 'b' : 'w';
                }
            }
            
            // Default to white for new games
            if (isNewGame) {
                return 'w';
            }
            
            console.warn('[FEN Sender] Could not determine active color');
            return 'w'; // Default to white if uncertain
        }
        
        // Active clock indicates whose turn it is
        if (whiteActive && !blackActive) {
            return 'w';
        }
        if (blackActive && !whiteActive) {
            return 'b';
        }
        
        console.warn('[FEN Sender] Ambiguous active color, defaulting to white');
        return 'w';
    }
    
    /**
     * Determines the current move number.
     * @returns {string} Move number as string
     */
    function determineMoveNumber() {
        const moveNrElements = document.querySelectorAll(`${MOVE_LIST_SELECTOR} ${MOVE_NUMBER_SELECTOR}`);
        if (moveNrElements.length > 0) {
            const lastMoveNrElement = moveNrElements[moveNrElements.length - 1];
            const moveNrText = lastMoveNrElement.textContent.trim().replace('.', '');
            const moveNr = parseInt(moveNrText, 10);
            
            // In FEN, move number is the number of the next full move
            // If it's black's turn, increment the displayed number
            const activeColor = determineActiveColor();
            return (activeColor === 'b' && !isNaN(moveNr)) ? String(moveNr) : 
                   (!isNaN(moveNr) ? String(moveNr) : '1');
        }
        return '1'; // Default for new games
    }
    
    /**
     * Calculates FEN and sends it to backend if changed.
     */
    function calculateAndSendFEN() {
        try {
            const newFen = generateFEN();
            
            if (!newFen) {
                console.warn('[FEN Sender] FEN generation failed, retrying in 1 second...');
                setTimeout(calculateAndSendFEN, 1000);
                return;
            }
            
            if (newFen !== currentFen) {
                currentFen = newFen;
                console.log(`[FEN Sender] New FEN: ${currentFen}`);
                sendFenToBackend(currentFen);
            }
        } catch (error) {
            console.error('[FEN Sender] Error calculating/sending FEN:', error);
            console.log('[FEN Sender] Retrying in 1 second...');
            setTimeout(calculateAndSendFEN, 1000);
        }
    }
    
    /**
     * Sends FEN to backend.
     * @param {string} fen - The FEN string to send
     */
    function sendFenToBackend(fen) {
        console.log(`[FEN Sender] Sending FEN to ${BACKEND_URL}`);
        
        GM_xmlhttpRequest({
            method: 'POST',
            url: BACKEND_URL,
            headers: {
                'Content-Type': 'application/json'
            },
            data: JSON.stringify({ fen: fen }),
            timeout: 5000,
            onload: function(response) {
                if (response.status >= 200 && response.status < 300) {
                    console.log(`[FEN Sender] FEN sent successfully (Status: ${response.status})`);
                } else {
                    console.error(`[FEN Sender] Backend error: ${response.status}`, response.responseText);
                }
            },
            onerror: function(response) {
                console.error(`[FEN Sender] Network error:`, response.statusText || 'Unknown error');
            },
            ontimeout: function() {
                console.error(`[FEN Sender] Request timed out`);
            }
        });
    }
    
    /**
     * Mutation observer callback.
     */
    const mutationCallback = function(mutationsList) {
        let relevantChangeDetected = false;
        
        for (const mutation of mutationsList) {
            if (mutation.type === 'attributes' || mutation.type === 'childList') {
                relevantChangeDetected = true;
                break;
            }
        }
        
        if (relevantChangeDetected) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(calculateAndSendFEN, DEBOUNCE_DELAY_MS);
        }
    };
    
    /**
     * Initializes the observer.
     */
    function initializeObserver() {
        const boardPiecesContainer = document.querySelector('.TheBoard-pieces');
        const playerBoxesContainer = document.querySelector('.TheBoard-playerboxes');
        const moveListContainer = document.querySelector(MOVE_LIST_SELECTOR);
        
        if (boardPiecesContainer && playerBoxesContainer && moveListContainer) {
            console.log('[FEN Sender] Required containers found. Starting observer.');
            
            // Create recalculate button
            createRecalculateButton();
            
            // Initial FEN calculation
            calculateAndSendFEN();
            
            // Setup observer
            const config = {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            };
            
            observer = new MutationObserver(mutationCallback);
            observer.observe(boardPiecesContainer, config);
            observer.observe(playerBoxesContainer, config);
            observer.observe(moveListContainer, config);
            
            console.log('[FEN Sender] Observer started successfully');
            
            // If we're in a game replay/analysis board, add button to re-enable moves panel
            if (document.querySelector('.analysis-diagram')) {
                console.log('[FEN Sender] Analysis board detected, recalculate button may be needed more frequently');
            }
        } else {
            console.log('[FEN Sender] Some containers not found, retrying in 1 second...');
            setTimeout(initializeObserver, 1000);
        }
    }
    
    // Start the script
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeObserver);
    } else {
        initializeObserver();
    }
    
    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (observer) {
            observer.disconnect();
            console.log('[FEN Sender] Observer disconnected');
        }
        clearTimeout(debounceTimer);
    });

    /**
     * Renders engine visualization data as SVG overlays
     * @param {Object} visualization - The complete engine visualization data
     */
    function renderEngineVisualization(visualization) {
        // Ensure we have the overlay
        createAnalysisOverlay();
        
        // Clear previous drawings
        clearAnalysisVisuals();
        
        const { engineLines, finalShapes } = visualization;
        
        // Get board dimensions for calculations
        const boardDimensions = getBoardDimensions();
        if (!boardDimensions) return;
        
        const { playingAsBlack } = determinePlayerColor();
        
        // Render each engine's lines
        Object.values(engineLines).forEach(engine => {
            const engineColor = ARROW_COLORS.engines[engine.engineIndex] || ARROW_COLORS.engines.default;
            
            engine.variations.forEach(variation => {
                variation.arrows.forEach(arrow => {
                    const color = variation.isMainLine ? engineColor : `${engineColor}80`; // 80 = 50% opacity
                    drawArrow(
                        arrow.from,
                        arrow.to,
                        color,
                        arrow.moveNumber,
                        boardDimensions,
                        playingAsBlack
                    );
                });
            });
        });
        
        // Render final shapes
        finalShapes.forEach(shape => {
            drawArrow(
                shape.from,
                shape.to,
                shape.color,
                shape.moveNumber || 1,
                boardDimensions,
                playingAsBlack
            );
        });
        
        // Add labels for each engine
        if (SHOW_LABELS) {
            Object.values(engineLines).forEach(engine => {
                const engineColor = ARROW_COLORS.engines[engine.engineIndex] || ARROW_COLORS.engines.default;
                const bestVariation = engine.variations[0];
                if (bestVariation && bestVariation.arrows.length > 0) {
                    const firstArrow = bestVariation.arrows[0];
                    addEngineLabel(
                        firstArrow.to,
                        `Engine ${engine.engineIndex + 1}`,
                        engineColor,
                        boardDimensions,
                        playingAsBlack
                    );
                }
            });
        }
    }

    /**
     * Adds a label for an engine at a specific square
     */
    function addEngineLabel(square, text, color, dimensions, playingAsBlack) {
        const coords = getSquareCoordinates(square, dimensions.squareSize, playingAsBlack);
        if (!coords) return;
        
        const label = document.createElement('div');
        label.textContent = text;
        label.style.position = 'absolute';
        label.style.left = `${coords.x - 15}px`;
        label.style.top = `${coords.y - 15}px`;
        label.style.backgroundColor = color;
        label.style.color = 'white';
        label.style.padding = '2px 5px';
        label.style.borderRadius = '3px';
        label.style.fontSize = '10px';
        label.style.fontWeight = 'bold';
        label.style.zIndex = '10';
        labelContainer.appendChild(label);
    }
})();
