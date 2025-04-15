// ==UserScript==
// @name        Chess.com Universal FEN & Analysis
// @namespace   Violentmonkey Scripts
// @match       *://*.chess.com/*
// @exclude     *://*.chess.com/news*
// @exclude     *://*.chess.com/articles*
// @exclude     *://*.chess.com/blog*
// @exclude     *://*.chess.com/forum*
// @exclude     *://*.chess.com/clubs*
// @exclude     *://*.chess.com/members*
// @exclude     *://*.chess.com/puzzles*
// @exclude     *://*.chess.com/openings*
// @exclude     *://*.chess.com/settings*
// @exclude     *://*.chess.com/support*
// @exclude     *://*.chess.com/community*
// @grant       GM_xmlhttpRequest
// @version     4.0
// @author      AI Assistant
// @description Dynamically detects chess boards on Chess.com, sends FEN to a local backend, and displays analysis arrows. Includes manual turn override.
// @connect     localhost
// @connect     127.0.0.1
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const BACKEND_URL = 'http://127.0.0.1:3030/fen';
    const WS_URL = 'ws://127.0.0.1:3030/ws';
    const DEBOUNCE_DELAY_MS = 150;
    const INIT_DELAY_MS = 750; // Delay initialization slightly to allow dynamic elements to load

    // --- Constants ---
    const LayoutType = {
        UNKNOWN: 0,
        WC_BOARD: 1,      // Found <wc-chess-board> (e.g., /play/computer, /analysis)
        LIVE_BOARD: 2,    // Found .TheBoard-layers (e.g., /live, old /game)
        // Add more types here if needed (e.g., variants might have unique structures)
    };

    // --- State Variables ---
    let currentFen = '';
    let debounceTimer = null;
    let observer = null;
    let cachedPlayerColor = null; // Can be boolean (auto-detected) or null
    let manualTurnOverride = null; // Can be 'w', 'b', or null
    let ws;

    // Board / UI Elements (populated by findChessBoard)
    let boardInfo = {
        boardElement: null,         // The core board element itself
        boardContainer: null,       // A parent container holding board, player boxes, etc.
        moveListContainer: null,    // The container for the move list
        playerBoxTop: null,
        playerBoxBottom: null,
        layoutType: LayoutType.UNKNOWN,
        selectors: {}               // Layout-specific selectors
    };

    // UI Buttons
    let recalculateButton = null;
    let setWhiteTurnButton = null;
    let setBlackTurnButton = null;

    // Analysis Visualization
    let currentAnalysis = {};
    let analysisOverlay = null;
    let labelContainer = null;
    const ARROW_COLORS = {
        singleEngine: [
            // Greyscale: Lightest for best, getting darker
            '#AAAAAA', // Best move (light grey)
            '#888888', // 2nd best 
            '#666666', // 3rd best
            '#444444', // 4th best
            '#222222'  // 5th best (dark grey)
        ],
        engines: {
            // Default colors for common engines - can be expanded
            'stockfish': '#3692E7',  // blue
            'lc0': '#E736C5',        // pink
            'komodo': '#8DE736',     // green
            'default': '#E7A336'     // orange (for any other engine)
        }
    };
    const ARROW_WIDTH = 15;
    const ARROW_OPACITY = 0.8;
    const SHOW_LABELS = true;

    // --- Initialization ---

    /**
     * Tries to find a recognizable chess board on the page.
     * Populates the global boardInfo object if successful.
     * @returns {boolean} True if a board was found, false otherwise.
     */
    function findChessBoard() {
        console.log('[Board Detector] Searching for chess board...');

        // Strategy 1: Web Component Board (<wc-chess-board>)
        const wcBoard = document.querySelector('wc-chess-board');
        if (wcBoard) {
            console.log('[Board Detector] Found <wc-chess-board>.');
            const container = wcBoard.closest('.board-layout-main, #board-layout-main, .analysis-diagram-component'); // Common containers
            // --- MODIFICATION START ---
            // Search the whole document for the move list, not just relative to the board
            const moveList = document.querySelector('wc-simple-move-list, .move-list-wrapper');
            // --- MODIFICATION END ---
            const playerTop = document.querySelector('#board-layout-player-top, .player-container.top');
            const playerBottom = document.querySelector('#board-layout-player-bottom, .player-container.bottom');

            if (container && moveList && playerTop && playerBottom) {
                boardInfo = {
                    boardElement: wcBoard,
                    boardContainer: container,
                    moveListContainer: moveList,
                    playerBoxTop: playerTop,
                    playerBoxBottom: playerBottom,
                    layoutType: LayoutType.WC_BOARD,
                    selectors: {
                        BOARD_ELEMENT_SELECTOR: 'wc-chess-board', // Use tag name directly if specific enough
                        PIECE_SELECTOR: '.piece[class*="square-"]',
                        COORD_LABEL_SELECTOR: 'svg.coordinates text',
                        MOVE_LIST_ROW_SELECTOR: '.main-line-row[data-whole-move-number]',
                        SELECTED_MOVE_NODE_SELECTOR: '.node.selected',
                        CLOCK_SELECTOR: '.clock-time-black, .clock-time-white, .clock-time-component span', // Try multiple possibilities
                        PLAYER_TAG_SELECTOR: '.user-tagline-username', // Example, needs checking
                        // Add perspective check selectors if needed (attributes like 'orientation')
                    }
                };
                console.log('[Board Detector] WC_BOARD layout confirmed with necessary elements.');
                return true;
            } else {
                 console.warn('[Board Detector] Found <wc-chess-board> but missing essential containers (container, moveList, player boxes).');
            }
        }

        // Strategy 2: Live Game Board (.TheBoard-layers)
        const liveBoardLayers = document.querySelector('.TheBoard-layers');
        if (liveBoardLayers) {
            console.log('[Board Detector] Found .TheBoard-layers (for /variants or /live).');
            // Use the layers div itself as the primary board element for this layout
            const boardElement = liveBoardLayers;
            // Try finding the container relative to the layers
            const container = liveBoardLayers.closest('.container-four-board-container, .board-layout-main, .live-game-container'); // Added .container-four-board-container
            // Target the specific sidebar panel for the move list in /variants
            const moveList = document.querySelector('#boardPanel .moves-moves-list .moves-table, .moves-moves-list div.moves-table, .move-list-wrapper'); // Added #boardPanel selector
            // Find player boxes within the layers element
            const playerTop = liveBoardLayers.querySelector('.playerbox-top');
            const playerBottom = liveBoardLayers.querySelector('.playerbox-bottom');

            if (boardElement && container && moveList && playerTop && playerBottom) {
                boardInfo = {
                    boardElement: boardElement,
                    boardContainer: container,
                    moveListContainer: moveList,
                    playerBoxTop: playerTop,
                    playerBoxBottom: playerBottom,
                    layoutType: LayoutType.LIVE_BOARD,
                    selectors: { // Update selectors for LIVE_BOARD
                        BOARD_ELEMENT_SELECTOR: '.TheBoard-layers', // Main layers div
                        PIECE_SELECTOR: '.TheBoard-pieces .piece[data-piece][style*="translate"]', // More specific piece location
                        COORD_LABEL_SELECTOR: '.Coordinates-component text', // More specific coords location
                        MOVE_LIST_ROW_SELECTOR: '.moves-table-row', // Appears correct
                        MOVE_NUMBER_SELECTOR: '.moves-full-move-nr', // Appears correct
                        MOVE_TABLE_CELL_SELECTOR: '.moves-table-cell.moves-move', // Appears correct
                        SELECTED_MOVE_SELECTOR: '.moves-pointer.moves-hl-move', // Selector for highlighted move in this layout
                        CLOCK_SELECTOR: '.clock-component', // Appears correct
                        PLAYER_TAG_SELECTOR: '.playerbox-username', // Specific username class
                        PERSPECTIVE_SELECTOR: '.TheBoard-layers', // Use layers div for perspective check
                    }
                };
                 console.log('[Board Detector] LIVE_BOARD layout confirmed with necessary elements (Updated for /variants).');
                return true;
            } else {
                 // Log which specific element was not found for debugging
                 console.warn(`[Board Detector] Found .TheBoard-layers but missing essential containers.`);
                 if (!boardElement) console.warn('  - boardElement not found (expected .TheBoard-layers)'); // Should always be found if we got here
                 if (!container) console.warn('  - container not found (tried .container-four-board-container, .board-layout-main, .live-game-container)');
                 if (!moveList) console.warn('  - moveList not found (tried #boardPanel .moves-moves-list .moves-table, .moves-moves-list div.moves-table, .move-list-wrapper)');
                 if (!playerTop) console.warn('  - playerTop not found (tried .playerbox-top inside .TheBoard-layers)');
                 if (!playerBottom) console.warn('  - playerBottom not found (tried .playerbox-bottom inside .TheBoard-layers)');
            }
        }

        // Add more strategies here for other board types if necessary (e.g., /variants)

        console.log('[Board Detector] No recognizable chess board found on this page.');
        boardInfo.layoutType = LayoutType.UNKNOWN;
        return false;
    }


    /**
     * Main initialization function.
     */
    function initializeScript() {
        if (!findChessBoard()) {
            // No board found, do nothing further.
            return;
        }

        console.log(`[FEN Sender] Initializing for layout type: ${boardInfo.layoutType}`);

        // Create UI Buttons
        createControlButtons();

        // Initial FEN calculation and send
        calculateAndSendFEN();

        // Initialize WebSocket for analysis
        connectWebSocket();

        // Setup MutationObserver
        initializeObserver();

        console.log('[FEN Sender] Initialization complete.');
    }


    // --- UI Button Creation and Handling ---

    function createControlButtons() {
        const controlsContainerId = 'userscript-fen-controls';
        let controlsContainer = document.getElementById(controlsContainerId);

        if (!controlsContainer) {
            controlsContainer = document.createElement('div');
            controlsContainer.id = controlsContainerId;
            controlsContainer.style.position = 'fixed';
            controlsContainer.style.bottom = '10px';
            controlsContainer.style.right = '10px';
            controlsContainer.style.zIndex = '10000'; // High z-index
            controlsContainer.style.display = 'flex';
            controlsContainer.style.flexDirection = 'column';
            controlsContainer.style.gap = '5px';
            document.body.appendChild(controlsContainer);
        }

        // Button Style Helper
        const applyButtonStyle = (button) => {
            button.style.padding = '5px 10px';
            button.style.fontSize = '12px';
            button.style.fontFamily = 'Arial, sans-serif';
            button.style.backgroundColor = '#4a4a4a'; // Darker grey base
            button.style.color = 'white';
            button.style.border = '1px solid #666';
            button.style.borderRadius = '4px';
            button.style.cursor = 'pointer';
            button.style.opacity = '0.85';
            button.style.transition = 'opacity 0.3s, background-color 0.3s';
             button.addEventListener('mouseover', () => { button.style.opacity = '1'; });
             button.addEventListener('mouseout', () => { if (!button.classList.contains('active-override')) button.style.opacity = '0.85'; });
        };

        // Recalculate Button
        if (!recalculateButton) {
            recalculateButton = document.createElement('button');
            recalculateButton.textContent = '↻ Recalculate FEN';
            recalculateButton.title = 'Force recalculation of board orientation, turn, and FEN';
            applyButtonStyle(recalculateButton);
            recalculateButton.style.backgroundColor = '#30844c'; // Green
            recalculateButton.addEventListener('click', resetAndRecalculate);
            controlsContainer.appendChild(recalculateButton);
            console.log('[FEN Sender] Recalculate button added.');
        }

        // Set White's Turn Button
        if (!setWhiteTurnButton) {
            setWhiteTurnButton = document.createElement('button');
            setWhiteTurnButton.textContent = 'Set White Turn';
            setWhiteTurnButton.title = 'Manually set active turn to White';
            applyButtonStyle(setWhiteTurnButton);
            setWhiteTurnButton.addEventListener('click', () => setManualTurn('w'));
            controlsContainer.appendChild(setWhiteTurnButton);
             console.log('[FEN Sender] Set White Turn button added.');
        }

         // Set Black's Turn Button
        if (!setBlackTurnButton) {
            setBlackTurnButton = document.createElement('button');
            setBlackTurnButton.textContent = 'Set Black Turn';
            setBlackTurnButton.title = 'Manually set active turn to Black';
            applyButtonStyle(setBlackTurnButton);
            setBlackTurnButton.addEventListener('click', () => setManualTurn('b'));
            controlsContainer.appendChild(setBlackTurnButton);
            console.log('[FEN Sender] Set Black Turn button added.');
        }

        updateTurnButtonStyles(); // Initial style update
    }

    function setManualTurn(turn) {
        console.log(`[FEN Sender] Manual turn override set to: ${turn}`);
        manualTurnOverride = turn;
        cachedPlayerColor = null; // Force recalculation of perspective if turn changes
        updateTurnButtonStyles();
        calculateAndSendFEN(); // Recalculate with override
    }

    function resetAndRecalculate() {
        console.log('[FEN Sender] Resetting cache and manual override...');
        cachedPlayerColor = null;
        manualTurnOverride = null;
        currentFen = ''; // Force resend even if FEN hasn't changed
        updateTurnButtonStyles();
        calculateAndSendFEN();
    }

    function updateTurnButtonStyles() {
        if (!setWhiteTurnButton || !setBlackTurnButton) return;

        setWhiteTurnButton.classList.remove('active-override');
        setBlackTurnButton.classList.remove('active-override');
        setWhiteTurnButton.style.backgroundColor = '#4a4a4a'; // Reset color
        setBlackTurnButton.style.backgroundColor = '#4a4a4a'; // Reset color
         setWhiteTurnButton.style.opacity = '0.85';
         setBlackTurnButton.style.opacity = '0.85';


        if (manualTurnOverride === 'w') {
            setWhiteTurnButton.classList.add('active-override');
            setWhiteTurnButton.style.backgroundColor = '#7aa9f0'; // Highlight blue
            setWhiteTurnButton.style.opacity = '1';
        } else if (manualTurnOverride === 'b') {
            setBlackTurnButton.classList.add('active-override');
            setBlackTurnButton.style.backgroundColor = '#7aa9f0'; // Highlight blue
            setBlackTurnButton.style.opacity = '1';
        }
    }

    // --- Core Logic (FEN Generation, Color, Move #) ---

    /**
     * Gets the board dimensions (Layout Specific). Used primarily for visualization now.
     * @returns {{boardSize: number, squareSize: number} | null}
     */
    function getBoardDimensions() {
        if (!boardInfo.boardElement) return null;

        const rect = boardInfo.boardElement.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.width <= 0 || rect.height <= 0) {
            console.error('[Dimensions] Board element has invalid rect dimensions:', rect);
            return null;
        }
        const boardSize = Math.min(rect.width, rect.height);
        const squareSize = boardSize / 8;
        return { boardSize, squareSize };
    }

     /**
     * Parses the square-xy class from a wc-chess-board piece element.
     * @param {Element} pieceElement - The piece DOM element.
     * @returns {string|null} Algebraic notation (e.g., "e4") or null.
     */
    function getSquareFromWcPiece(pieceElement) {
        // Iterate through classList for robustness
        for (const cls of pieceElement.classList) {
            // Use regex that matches the class exactly: starts with square-, ends with two digits.
            const match = cls.match(/^square-(\d)(\d)$/);
            if (match) {
                const fileIndex = parseInt(match[1], 10); // 1-8
                const rankIndex = parseInt(match[2], 10); // 1-8
                if (fileIndex >= 1 && fileIndex <= 8 && rankIndex >= 1 && rankIndex <= 8) {
                    const file = String.fromCharCode('a'.charCodeAt(0) + fileIndex - 1);
                    const rank = rankIndex;
                    return `${file}${rank}`;
                } else {
                    // This case should ideally not happen if the regex matches
                    console.warn(`[FEN Gen DBG WC] Matched square class '${cls}' but indices ${fileIndex},${rankIndex} are invalid.`);
                }
            }
        }
        // If no class matched the pattern
        return null;
    }

    /**
     * Parses the piece type and color from a wc-chess-board piece element.
     * @param {Element} pieceElement - The piece DOM element.
     * @returns {{type: string, color: string}|null} e.g., {type: 'p', color: 'w'} or null.
     */
    function getPieceInfoFromWcPiece(pieceElement) {
        // Iterate through classes to find the piece identifier (e.g., 'wp', 'bk')
        for (const cls of pieceElement.classList) {
            if (cls.length === 2 && ['w', 'b'].includes(cls[0]) && ['p', 'n', 'b', 'r', 'q', 'k'].includes(cls[1])) {
                return {
                    color: cls[0], // 'w' or 'b'
                    type: cls[1] // 'p', 'n', 'b', 'r', 'q', 'k'
                };
            }
        }
        return null;
    }

    /**
     * Maps pixel coordinates to algebraic notation (for LIVE_BOARD layout).
     * @param {number} x - Pixel X coordinate relative to board top-left
     * @param {number} y - Pixel Y coordinate relative to board top-left
     * @param {number} squareSize - Square size in pixels
     * @param {boolean} playingAsBlack - Whether the board is visually flipped
     * @returns {string|null} Algebraic notation (e.g., "e4") or null
     */
    function mapCoordsToSquare(x, y, squareSize, playingAsBlack) { // Add playingAsBlack
         if (boardInfo.layoutType !== LayoutType.LIVE_BOARD) {
             console.warn('[FEN Sender] mapCoordsToSquare called for non-LIVE_BOARD layout.');
             return null;
         }
         if (!squareSize || squareSize <= 0) {
            console.warn('[mapCoordsToSquare DBG] Invalid squareSize:', squareSize);
            return null;
         }

         // Calculate indices based purely on pixels (0,0 = top-left)
         let fileIndexFromLeft = Math.floor(x / squareSize); // 0-7, 0=leftmost column visually
         let rankIndexFromTop = Math.floor(y / squareSize); // 0-7, 0=topmost row visually

         // Validate pixel-based indices before adjustment
         if (fileIndexFromLeft < 0 || fileIndexFromLeft > 7 || rankIndexFromTop < 0 || rankIndexFromTop > 7) {
             console.warn(`[mapCoordsToSquare DBG] Coords map to invalid pixel index: x=${x.toFixed(0)}, y=${y.toFixed(0)}, sqSize=${squareSize.toFixed(2)} -> fileIdxLeft=${fileIndexFromLeft}, rankIdxTop=${rankIndexFromTop}`);
             return null;
         }

         // Adjust indices based on perspective to get correct algebraic square
         // File: If playingAsBlack, the leftmost pixel column (0) corresponds to the 'h' file (index 7)
         const algebraicFileIndex = playingAsBlack ? 7 - fileIndexFromLeft : fileIndexFromLeft; // 0-7 index corresponding to file a-h

         // --- CORRECTED RANK CALCULATION START ---
         // Rank: Determine the algebraic rank number (1-8) based on the visual row index (0=top, 7=bottom) and perspective
         let algebraicRankNumber;
         if (playingAsBlack) {
            // If Black is at the bottom, visual top row (0) is Rank 1, visual bottom row (7) is Rank 8
            algebraicRankNumber = rankIndexFromTop + 1;
         } else {
            // If White is at the bottom, visual top row (0) is Rank 8, visual bottom row (7) is Rank 1
            algebraicRankNumber = 8 - rankIndexFromTop;
         }
         // --- CORRECTED RANK CALCULATION END ---

         // Convert file index and rank number to algebraic notation string
         const file = String.fromCharCode('a'.charCodeAt(0) + algebraicFileIndex);
         const rank = algebraicRankNumber;

         // Add a debug log to trace the mapping
         console.log(`[mapCoordsToSquare DBG] x=${x.toFixed(0)}, y=${y.toFixed(0)}, sqSize=${squareSize.toFixed(2)}, playingAsBlack=${playingAsBlack} => pixelFileLeft=${fileIndexFromLeft}, pixelRankTop=${rankIndexFromTop} => algFileIdx=${algebraicFileIndex}, algRankNum=${algebraicRankNumber} => ${file}${rank}`);

         return `${file}${rank}`;
    }

    /**
     * Determines player color (perspective) using dynamic selectors.
     * @returns {{playingAsBlack: boolean}} Object indicating if the player is playing as black
     */
    function determinePlayerColor() {
        console.log('[Player Color DBG] Determining player color...');
        let playingAsBlack = false; // Default assumption
        const selectors = boardInfo.selectors;
        let log = ["[Player Color DBG] Details:"];

        if (!boardInfo.boardElement || !selectors || Object.keys(selectors).length === 0) {
            console.error("[Player Color] Cannot determine color - board info or selectors missing.");
            log.push("  - Error: Board info or selectors missing.");
            console.log(log.join('\\n'));
            return { playingAsBlack: false };
        }
        log.push(`  - Layout Type: ${boardInfo.layoutType}`);

        let foundExplicitOrientation = false;
        let determinationMethod = 'default (no method applied)';

        // --- NEW: Enhanced Logging ---
        const boardElement = boardInfo.boardElement;
        const boardParent = boardElement.parentElement;
        const boardContainer = boardElement.closest('.board-layout-main, #board-layout-main, .analysis-diagram-component');
        log.push(`    Board Element Tag: ${boardElement.tagName}, ID: ${boardElement.id}`);
        log.push(`    Board Element Classes: [${Array.from(boardElement.classList).join(', ')}]`);
        log.push(`    Board Element Orientation Attr: ${boardElement.getAttribute('orientation')}`);
        if (boardParent) {
            log.push(`    Board Parent Tag: ${boardParent.tagName}, ID: ${boardParent.id}`);
            log.push(`    Board Parent Classes: [${Array.from(boardParent.classList).join(', ')}]`);
        }
        if (boardContainer) {
             log.push(`    Board Container Tag: ${boardContainer.tagName}, ID: ${boardContainer.id}`);
            log.push(`    Board Container Classes: [${Array.from(boardContainer.classList).join(', ')}]`);
        }
        // --- End Enhanced Logging ---

        // --- Method 1: Check Board Element Directly ---
        log.push("  - Method: Checking Board Element Directly");
        const boardOrientation = boardElement.getAttribute('orientation');
        if (boardOrientation === 'black') {
            // *** ADDED LOG ***
            log.push("    *** TRIGGERED: boardOrientation === 'black' ***");
            log.push("    -> Found orientation='black' attribute on board element. Setting playingAsBlack=true.");
            playingAsBlack = true;
            foundExplicitOrientation = true;
            determinationMethod = 'explicit board attribute';
        } else if (boardOrientation === 'white') {
             log.push("    -> Found orientation='white' attribute on board element. Setting playingAsBlack=false.");
            playingAsBlack = false;
            foundExplicitOrientation = true;
            determinationMethod = 'explicit board attribute (white)';
        } else if (boardElement.classList.contains('flipped')) {
             // *** ADDED LOG ***
            log.push("    *** TRIGGERED: boardElement.classList.contains('flipped') ***");
            log.push("    -> Found 'flipped' class on board element. Setting playingAsBlack=true.");
            playingAsBlack = true;
            foundExplicitOrientation = true;
            determinationMethod = 'explicit board class (flipped)';
        } else if (boardElement.classList.contains('black-perspective')) {
             // *** ADDED LOG ***
            log.push("    *** TRIGGERED: boardElement.classList.contains('black-perspective') ***");
            log.push("    -> Found 'black-perspective' class on board element. Setting playingAsBlack=true.");
            playingAsBlack = true;
            foundExplicitOrientation = true;
            determinationMethod = 'explicit board class (black-perspective)';
        } else {
            log.push("    -> No definitive orientation found on board element.");
        }

        // --- Method 2: Check Container Element (if not found above) ---
        if (!foundExplicitOrientation && boardContainer) {
            log.push("  - Method: Checking Container Element");
            if (boardContainer.classList.contains('flipped')) {
                // *** ADDED LOG ***
                log.push("    *** TRIGGERED: boardContainer.classList.contains('flipped') ***");
                log.push("    -> Found 'flipped' class on container. Setting playingAsBlack=true.");
                playingAsBlack = true;
                foundExplicitOrientation = true;
                determinationMethod = 'explicit container class (flipped)';
            } else if (boardContainer.classList.contains('black-perspective')) {
                 // *** ADDED LOG ***
                log.push("    *** TRIGGERED: boardContainer.classList.contains('black-perspective') ***");
                 log.push("    -> Found 'black-perspective' class on container. Setting playingAsBlack=true.");
                playingAsBlack = true;
                foundExplicitOrientation = true;
                determinationMethod = 'explicit container class (black-perspective)';
            }
             // Add container orientation check if needed, e.g.:
            // else if (boardContainer.getAttribute('orientation') === 'black') { ... }
             else {
                log.push("    -> No definitive orientation found on container element.");
            }
        }

        // --- Method 3: LIVE_BOARD Fallback (Coordinate Check - Only if needed and applicable) ---
        if (!foundExplicitOrientation && boardInfo.layoutType === LayoutType.LIVE_BOARD) {
            log.push("  - Method: Fallback (LIVE_BOARD Coordinate Check)");
            determinationMethod = 'coordinate fallback'; // Overwrite if successful
            const coordSelector = selectors.COORD_LABEL_SELECTOR;
            const coordLabels = boardInfo.boardElement.querySelectorAll(coordSelector);
            if (coordLabels.length > 0) {
                 log.push(`    Found ${coordLabels.length} elements matching coord selector '${coordSelector}'.`);
                const rank1Label = Array.from(coordLabels).find(label => label.textContent?.trim() === '1');
                const rank8Label = Array.from(coordLabels).find(label => label.textContent?.trim() === '8');
                const rank1YText = rank1Label?.getAttribute('y');
                const rank8YText = rank8Label?.getAttribute('y');
                const rank1Y = rank1YText ? parseFloat(rank1YText) : null;
                const rank8Y = rank8YText ? parseFloat(rank8YText) : null;

                log.push(`    Rank '1' Label? ${!!rank1Label} (Y Text: ${rank1YText}, Y Parsed: ${rank1Y})`);
                log.push(`    Rank '8' Label? ${!!rank8Label} (Y Text: ${rank8YText}, Y Parsed: ${rank8Y})`);

                if (rank1Y !== null && rank8Y !== null && !isNaN(rank1Y) && !isNaN(rank8Y)) {
                    if (rank1Y < rank8Y) {
                         // *** ADDED LOG ***
                        log.push("    *** TRIGGERED: rank1Y < rank8Y (Coordinate Check) ***");
                        log.push("    -> Rank 1 Y < Rank 8 Y. Setting playingAsBlack=true.");
                        playingAsBlack = true;
                        foundExplicitOrientation = true; // Mark as found
                    } else if (rank1Y > rank8Y) {
                         log.push("    -> Rank 1 Y > Rank 8 Y. Confirming playingAsBlack=false (White perspective).");
                         playingAsBlack = false;
                         foundExplicitOrientation = true; // Mark as found
                         determinationMethod = 'coordinate fallback (white)'; // Specify method
                    } else {
                         log.push("    -> Rank 1 Y == Rank 8 Y. Unusual state, reverting to default White.");
                         determinationMethod = 'default';
                    }
                } else {
                    log.push("    -> Could not find/parse both Rank 1 and Rank 8 Y coordinates for fallback. Reverting to default White.");
                     determinationMethod = 'default';
                }
            } else {
                log.push("    -> No coordinate labels found for fallback. Reverting to default White.");
                 determinationMethod = 'default';
            }
        }

        // Final assignment if no method worked
        if (!foundExplicitOrientation) {
             log.push(`  - Method: No explicit or fallback orientation found for layout ${boardInfo.layoutType}. Keeping default White.`);
             determinationMethod = 'default';
        }

        log.push(`[Player Color] Final determination: ${playingAsBlack ? 'BLACK' : 'WHITE'} (Based on ${determinationMethod})`);
        console.log(log.join('\\n'));

        return { playingAsBlack };
    }

    /**
     * Determines whose turn it is to move (Uses override first, then auto-detection).
     * @returns {string} 'w' for white, 'b' for black
     */
    function determineActiveColor() {
        // --- Manual Override ---
        if (manualTurnOverride) {
            console.log(`[Active Color] Using manual override: ${manualTurnOverride}`);
            return manualTurnOverride;
        }

        // --- Automatic Detection ---
        console.log('[Active Color] Determining active color automatically...');
        const selectors = boardInfo.selectors;
        let activeColor = 'w'; // Default assumption

        if (!boardInfo.moveListContainer || !selectors || Object.keys(selectors).length === 0) {
             console.error("[Active Color] Cannot determine color - move list container or selectors missing.");
             return activeColor; // Default to white on error
        }
        // Keep this log for context
        // console.log(`[Active Color DBG WC HTML] Move List Container HTML (first 500 chars):`, boardInfo.moveListContainer.innerHTML.substring(0, 500)); // Less useful now

        // Strategy 1 (WC_BOARD - remains the same)
        if (boardInfo.layoutType === LayoutType.WC_BOARD) {
             const selectedSpan = boardInfo.moveListContainer.querySelector('span.selected');
             // console.log(`[Active Color DBG WC Sel] Result of querySelector('span.selected'):`, selectedSpan); // Keep if needed

             if (selectedSpan) {
                 const selectedNode = selectedSpan.closest('.node'); // Find the parent div with class 'node'
                 // console.log('[Active Color DBG WC Sel] Found selected node via span:', selectedNode?.outerHTML, 'Classes:', selectedNode?.className); // Keep if needed

                 if (selectedNode) {
                     if (selectedNode.classList.contains('white-move')) {
                         // console.log('[Active Color DBG WC Sel] Parent node has "white-move". It is Black\'s turn.');
                         return 'b'; // White made the selected move, so it's Black's turn
                     } else if (selectedNode.classList.contains('black-move')) {
                          // console.log('[Active Color DBG WC Sel] Parent node has "black-move". It is White\'s turn.');
                         return 'w'; // Black made the selected move, so it's White's turn
                     } else {
                         console.warn('[Active Color DBG WC Sel] Found selected node via span, but parent lacks "white-move" or "black-move". Falling back.');
                     }
                 } else {
                      console.warn('[Active Color DBG WC Sel] Found selected span, but could not find parent .node element.');
                 }
             } else {
                 console.log('[Active Color] No selected span found for WC_BOARD. Falling back.');
             }
        }
        // Strategy 2: Check highlighted move in LIVE_BOARD move list (REVISED)
        else if (boardInfo.layoutType === LayoutType.LIVE_BOARD && selectors.SELECTED_MOVE_SELECTOR && selectors.MOVE_TABLE_CELL_SELECTOR && selectors.MOVE_LIST_ROW_SELECTOR) {
              console.log(`[Active Color DBG LB] Using selector: '${selectors.SELECTED_MOVE_SELECTOR}'`);
              const highlightedMoveElement = boardInfo.moveListContainer.querySelector(selectors.SELECTED_MOVE_SELECTOR);

              if (highlightedMoveElement) {
                  console.log('[Active Color DBG LB] Found highlighted move element:', highlightedMoveElement.outerHTML);
                  const moveCell = highlightedMoveElement.closest(selectors.MOVE_TABLE_CELL_SELECTOR);
                  const moveRow = highlightedMoveElement.closest(selectors.MOVE_LIST_ROW_SELECTOR);

                  if (moveCell && moveRow) {
                      const cellsInRow = Array.from(moveRow.querySelectorAll(selectors.MOVE_TABLE_CELL_SELECTOR));
                      const moveIndexInRow = cellsInRow.findIndex(cell => cell.contains(moveCell));
                      // Check for empty cells which might affect index
                      const moveCellsInRow = cellsInRow.filter(cell => cell.querySelector('span') && cell.textContent.trim() !== ''); // Find cells that actually contain a move span
                      const actualMoveIndex = moveCellsInRow.findIndex(cell => cell.contains(moveCell));

                      // Assuming structure: [White Move Cell], [Black Move Cell] (from selector .moves-table-cell.moves-move)
                      // Index 0 = White's move was highlighted -> Black's turn
                      // Index 1 = Black's move was highlighted -> White's turn
                      if (actualMoveIndex === 0) { // White move cell is highlighted
                          console.log(`[Active Color DBG LB Revised] Highlighted move is White's move (actual index ${actualMoveIndex} in filtered cells). Black to move.`);
                          return 'b'; // Correct: Black's turn
                      } else if (actualMoveIndex === 1) { // Black move cell is highlighted
                          console.log(`[Active Color DBG LB Revised] Highlighted move is Black's move (actual index ${actualMoveIndex} in filtered cells). White to move.`);
                          return 'w'; // Correct: White's turn
                      } else {
                          // This path should ideally not be taken if structure is consistent
                          console.warn('[Active Color DBG LB Revised] Highlighted move found, but actual index is unexpected (original index:', moveIndexInRow, 'filtered index:', actualMoveIndex, '). Falling back.');
                      }
                  } else {
                       console.warn('[Active Color DBG LB] Could not find parent move cell or row for highlighted element. Falling back.');
                  }
              } else {
                  // Fallback: If no move is highlighted, count existing moves to determine turn.
                  console.log('[Active Color DBG LB] No highlighted move found. Counting existing moves...');
                  const moveCells = boardInfo.moveListContainer.querySelectorAll(selectors.MOVE_TABLE_CELL_SELECTOR + ':not(:empty)');
                  const moveCount = moveCells.length;

                  if (moveCount === 0) {
                      console.log('[Active Color DBG LB Fallback] No moves found. Assuming start of game (White to move).');
                      return 'w'; // Start of the game
                  } else if (moveCount % 2 !== 0) {
                      // Odd number of moves means White made the last move.
                      console.log(`[Active Color DBG LB Fallback] Found ${moveCount} moves (odd). Assuming Black to move.`);
                      return 'b'; // Black's turn
                  } else {
                      // Even number of moves means Black made the last move.
                      console.log(`[Active Color DBG LB Fallback] Found ${moveCount} moves (even). Assuming White to move.`);
                      return 'w'; // White's turn
                  }
              }
         }

        // Strategy 3: Ultimate Fallback (remains the same)
        console.warn('[Active Color] Could not determine reliably from move list strategies. Defaulting to White.');
        return activeColor; // Return default 'w' if other strategies fail
    }

    /**
     * Determines the current move number.
     * @returns {string} Move number as string
     */
    function determineMoveNumber() {
        let moveNr = 1; // Default
        const selectors = boardInfo.selectors;

         if (!boardInfo.moveListContainer || !selectors || Object.keys(selectors).length === 0) {
             console.error("[Move Number] Cannot determine - move list container or selectors missing.");
             return String(moveNr);
         }

        try {
            if (boardInfo.layoutType === LayoutType.WC_BOARD && selectors.MOVE_LIST_ROW_SELECTOR) {
                const moveRowElements = boardInfo.moveListContainer.querySelectorAll(selectors.MOVE_LIST_ROW_SELECTOR);
                if (moveRowElements.length > 0) {
                    const lastMoveRowElement = moveRowElements[moveRowElements.length - 1];
                    const moveNrText = lastMoveRowElement.getAttribute('data-whole-move-number');
                    const parsedNr = parseInt(moveNrText, 10);
                    if (!isNaN(parsedNr)) moveNr = parsedNr;
                }
            } else if (boardInfo.layoutType === LayoutType.LIVE_BOARD && selectors.MOVE_NUMBER_SELECTOR) {
                const moveNrElements = boardInfo.moveListContainer.querySelectorAll(selectors.MOVE_NUMBER_SELECTOR);
                if (moveNrElements.length > 0) {
                    const lastMoveNrElement = moveNrElements[moveNrElements.length - 1];
                    const moveNrText = lastMoveNrElement.textContent.trim().replace(/\.$/, '');
                    const parsedNr = parseInt(moveNrText, 10);
                     if (!isNaN(parsedNr)) moveNr = parsedNr;
                }
            }
        } catch (error) {
            console.error("[Move Number] Error parsing move number:", error);
        }

         // Adjust FEN move number: increments after Black moves
         const activeColor = determineActiveColor(); // Get whose turn it *is*
         // If it's White's turn, it means Black just completed the previous move number.
         // If it's Black's turn, White just moved, starting the current move number.
         // FEN standard: The number of the *next* full move.
         // After 1. e4 -> active='b', FEN needs '1'
         // After 1... e5 -> active='w', FEN needs '2'
         // After 2. Nf3 -> active='b', FEN needs '2'
         // After 2... Nc6 -> active='w', FEN needs '3'
         // So, if activeColor is 'w', the FEN number should be moveNr + 1 (unless it's the very start).
         // If activeColor is 'b', the FEN number is moveNr.

         // Corrected FEN move number logic:
         if (activeColor === 'w') {
            // White is about to move, meaning Black just finished move number 'moveNr'.
            // The FEN represents the state *before* White moves, so the move number is the *next* full move.
             return String(moveNr + 1);
         } else {
            // Black is about to move, meaning White just finished move number 'moveNr'.
            // The FEN represents the state *before* Black moves, so the current full move number applies.
            return String(moveNr);
         }
    }


    /**
     * Generates a FEN string representing the current board position.
     * @returns {string|null} FEN string or null on error
     */
    function generateFEN() {
         if (!boardInfo.boardElement || !boardInfo.selectors || Object.keys(boardInfo.selectors).length === 0) {
             console.error("[FEN Gen] Cannot generate FEN - board element or selectors missing.");
             return null;
         }
         // console.log("[FEN Gen DBG] Starting FEN generation for layout:", boardInfo.layoutType); // Existing DEBUG

         const { playingAsBlack } = determinePlayerColor(); // Determine perspective FIRST
         const board = Array(8).fill(null).map(() => Array(8).fill(null)); // FEN board: index 0 = rank 8, index 7 = rank 1
         const pieces = boardInfo.boardElement.querySelectorAll(boardInfo.selectors.PIECE_SELECTOR);
         console.log(`[FEN Gen DBG] Found ${pieces.length} elements matching piece selector '${boardInfo.selectors.PIECE_SELECTOR}'`); // Keep this DEBUG log
         let pieceCount = 0;
         const dims = getBoardDimensions(); // Get dimensions, might be needed for LIVE_BOARD
          // *** FEN GEN DEBUG LOG ***
          console.log(`[FEN Gen DBG] Board Dimensions for coord mapping:`, dims ? `Size=${dims.boardSize}, Square=${dims.squareSize}` : 'null/invalid');
          console.log(`[FEN Gen DBG] Using perspective playingAsBlack=${playingAsBlack} for FEN generation.`); // Log perspective being used

        pieces.forEach((piece, index) => { // Added index for logging
            let square = null; // Algebraic square (e.g., 'e4')
            let fenChar = null; // FEN character (e.g., 'P', 'n')

            try {
                if (boardInfo.layoutType === LayoutType.WC_BOARD) {
                    square = getSquareFromWcPiece(piece); // Assumes this handles perspective correctly internally if needed
                    const pieceInfo = getPieceInfoFromWcPiece(piece);
                    if (square && pieceInfo) {
                        fenChar = pieceInfo.color === 'w' ? pieceInfo.type.toUpperCase() : pieceInfo.type.toLowerCase();
                    } else {
                         console.warn(`[FEN Gen DBG WC Piece ${index+1}] Could not get square/piece info for:`, piece.outerHTML);
                    }
                } else if (boardInfo.layoutType === LayoutType.LIVE_BOARD) {
                    const pieceType = piece.dataset.piece; // e.g., "P", "N", "B", "R", "Q", "K" (Chess.com uses uppercase regardless of color here)
                    let pieceColor = null;
                    const dataColorAttr = piece.dataset.color; // Use '5' for white, '6' for black
                    if (dataColorAttr === '5') pieceColor = 'w';
                    else if (dataColorAttr === '6') pieceColor = 'b';

                    // Fallback if data-color isn't present (less likely but possible)
                    if (!pieceColor && piece.dataset.piece?.length === 2) {
                         console.warn(`[FEN Gen DBG Piece ${index+1}] Using data-piece[0] for color fallback (data-color was: ${dataColorAttr})`);
                         pieceColor = piece.dataset.piece[0].toLowerCase(); // Ensure 'w' or 'b'
                    }

                    const transform = piece.style.transform;
                    const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)/);

                     // Log details before mapping
                    // console.log(`[FEN Gen DBG Piece ${index+1}] Data: pieceType=${pieceType}, pieceColor=${pieceColor}, dataColor=${dataColorAttr}, transform=${transform}, match=${!!match}, dims=${!!dims}`);

                    if (pieceType && pieceColor && match && dims?.squareSize > 0) {
                         const x = parseFloat(match[1]);
                         const y = parseFloat(match[2]);
                         // Call mapCoordsToSquare, passing the determined perspective
                         square = mapCoordsToSquare(x, y, dims.squareSize, playingAsBlack);

                        if (square) {
                             // FEN char uses uppercase for white, lowercase for black
                            fenChar = pieceColor === 'w' ? pieceType.toUpperCase() : pieceType.toLowerCase();
                             // console.log(`[FEN Gen DBG Piece ${index+1}] Mapped: x=${x.toFixed(0)},y=${y.toFixed(0)} -> square=${square} -> fenChar=${fenChar}`);
                        } else {
                             console.warn(`[FEN Gen DBG Piece ${index+1}] mapCoordsToSquare returned null for x=${x.toFixed(0)}, y=${y.toFixed(0)}, playingAsBlack=${playingAsBlack}`);
                        }
                    } else {
                        // Attempt fallback using class name if color is missing
                        let foundColorViaClass = false;
                        if (!pieceColor) {
                            for (const cls of piece.classList) {
                                if (cls.length === 2 && ['w', 'b'].includes(cls[0]) && ['p', 'n', 'b', 'r', 'q', 'k'].includes(cls[1])) {
                                    pieceColor = cls[0];
                                    foundColorViaClass = true;
                                    console.log(`[FEN Gen DBG Piece ${index+1}] Color Fallback via class '${cls}' successful. Color: ${pieceColor}`);
                                    break;
                                }
                            }
                        }

                        if (pieceType && pieceColor && match && dims?.squareSize > 0) {
                            const x = parseFloat(match[1]);
                            const y = parseFloat(match[2]);
                            square = mapCoordsToSquare(x, y, dims.squareSize, playingAsBlack);
                            if (square) {
                                fenChar = pieceColor === 'w' ? pieceType.toUpperCase() : pieceType.toLowerCase();
                            } else {
                                 console.warn(`[FEN Gen DBG Piece ${index+1}] mapCoordsToSquare returned null after fallback for x=${x.toFixed(0)}, y=${y.toFixed(0)}, playingAsBlack=${playingAsBlack}`);
                            }
                        } else {
                            console.warn(`[FEN Gen DBG Piece ${index+1}] Skipping coord mapping after fallback: Missing data (type=${pieceType}, color=${pieceColor} (foundViaClass: ${foundColorViaClass}), match=${!!match}, dims=${!!dims}, squareSize=${dims?.squareSize})`);
                        }
                    }
                }

                // Place the piece on the FEN board array (ranks 8 to 1 -> index 0 to 7)
                if (square && fenChar) {
                    const fileIndex = square.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7 (a=0, h=7)
                    const rankNumber = parseInt(square[1], 10); // 1-8
                    const fenRankIndex = 8 - rankNumber; // 0-7 (rank 8 = index 0, rank 1 = index 7)

                    if (fenRankIndex >= 0 && fenRankIndex <= 7 && fileIndex >= 0 && fileIndex <= 7) {
                        if (board[fenRankIndex][fileIndex] === null) {
                            board[fenRankIndex][fileIndex] = fenChar;
                            pieceCount++;
                        } else {
                             console.warn(`[FEN Gen DBG] Collision at ${square} (FEN Indices: [${fenRankIndex}][${fileIndex}]): existing=${board[fenRankIndex][fileIndex]}, new=${fenChar}`);
                        }
                    } else {
                         console.warn(`[FEN Gen DBG] Invalid FEN indices calculated: square=${square} -> fenRankIndex=${fenRankIndex}, fileIndex=${fileIndex}`);
                    }
                } else {
                     // console.warn(`[FEN Gen DBG Piece ${index+1}] Skipping placement: square (${square}) or fenChar (${fenChar}) is invalid.`);
                }
             } catch (e) {
                  console.error(`[FEN Gen DBG Piece ${index+1}] Error processing piece:`, piece.outerHTML, e);
             }
        });

         if (pieceCount === 0 && pieces.length > 0) { // Only error if pieces existed but none were placed
             console.error('[FEN Gen] Failed to place any pieces on the board array despite finding piece elements. Final pieceCount:', pieceCount);
             return null;
         }
         console.log(`[FEN Gen DBG] Finished processing ${pieces.length} pieces. Placed ${pieceCount} pieces onto FEN board.`);

        // Convert board array to FEN string (ranks 8 down to 1)
        // FEN standard is Rank 8 first. Our array index 0 is Rank 8.
        // The FEN string must ALWAYS be from White's perspective (rank 8 down to 1),
        // regardless of the visual orientation ('playingAsBlack').
        // The 'board' array is already populated correctly from White's perspective.
        // REMOVED: const boardForFen = playingAsBlack ? [...board].reverse() : board;

        let fenPiecePlacement = '';
         for (let r = 0; r < 8; r++) { // Iterate through the board array (Rank 8 to 1)
              let emptyCount = 0;
              for (let f = 0; f < 8; f++) { // f = 0 (a-file) to f = 7 (h-file)
                  if (board[r][f]) { // Use the original 'board' array directly
                      if (emptyCount > 0) fenPiecePlacement += emptyCount;
                      fenPiecePlacement += board[r][f]; // Use the original 'board' array directly
                      emptyCount = 0;
                  } else {
                      emptyCount++;
                  }
              }
              if (emptyCount > 0) fenPiecePlacement += emptyCount;
              if (r < 7) fenPiecePlacement += '/';
         }


        const activeColor = determineActiveColor();
        const castling = '-'; // Placeholder - TODO: Implement castling detection
        const enPassant = '-'; // Placeholder - TODO: Implement en passant detection
        const halfMove = '0'; // Placeholder - TODO: Implement halfmove clock
        const moveNumber = determineMoveNumber(); // Get the full move number

        const finalFen = `${fenPiecePlacement} ${activeColor} ${castling} ${enPassant} ${halfMove} ${moveNumber}`;
         console.log(`[FEN Gen] Generated FEN (Perspective: ${playingAsBlack ? 'Black' : 'White'}, Piece Count: ${pieceCount}): ${finalFen}`);
         return finalFen;
    }


    /**
     * Calculates FEN and sends it to backend if changed.
     */
    function calculateAndSendFEN() {
         if (boardInfo.layoutType === LayoutType.UNKNOWN) return; // Don't run if no board

        try {
            console.log('[FEN Sender] Running calculateAndSendFEN...');
            const newFen = generateFEN();
            console.log(`[FEN Sender] Generated FEN: ${newFen}, Current FEN: ${currentFen}`);

            if (!newFen) {
                console.warn('[FEN Sender] FEN generation failed or returned null.');
                return;
            }

            if (newFen !== currentFen) {
                 console.log(`[FEN Sender] FEN changed! Old: "${currentFen || '(empty)'}", New: "${newFen}". Sending...`);
                currentFen = newFen;
                sendFenToBackend(currentFen);
                // Trigger redraw of analysis if needed (only if analysis data exists)
                if (Object.keys(currentAnalysis).length > 0) {
                    // Re-render visualization with potentially updated perspective
                     renderEngineVisualization(currentAnalysis);
                     console.log('[FEN Sender] Triggered analysis re-render due to FEN change.');
                }
            } else {
                 console.log('[FEN Sender] FEN unchanged. Not sending.');
            }
        } catch (error) {
            console.error('[FEN Sender] Error calculating/sending FEN:', error);
        }
    }

    /**
     * Sends FEN to backend.
     * @param {string} fen - The FEN string to send
     */
    function sendFenToBackend(fen) {
        // *** ADDED LOG ***
        console.log(`[FEN Sender] Preparing to send FEN via POST to ${BACKEND_URL}: "${fen}"`);
        GM_xmlhttpRequest({
            method: 'POST',
            url: BACKEND_URL,
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8' // Send as plain text
            },
            data: fen, // Send the FEN string directly as the body
            onload: function(response) {
                // *** ADDED LOG ***
                console.log(`[FEN Sender] POST Success! Status: ${response.status}, Response: ${response.responseText}`);
            },
            onerror: function(response) {
                 // *** ADDED LOG ***
                 console.error(`[FEN Sender] POST Error! Status: ${response.status}, Status Text: ${response.statusText}, Error: ${response.error}, Response: ${response.responseText}`);
            },
            ontimeout: function() {
                 // *** ADDED LOG ***
                 console.error(`[FEN Sender] POST Timeout!`);
            }
        });
    }

    // --- Mutation Observer ---

    /**
     * Mutation observer callback.
     */
    const mutationCallback = function(mutationsList) {
        let relevantChangeDetected = false;

        for (const mutation of mutationsList) {
            // More robust check: ensure the mutation happened within our observed container/board
             // Optimization: Check target directly first, then closest container if needed
             let targetIsRelevant = false;
             if (boardInfo.boardElement?.contains(mutation.target) ||
                 boardInfo.moveListContainer?.contains(mutation.target) ||
                 boardInfo.playerBoxTop?.contains(mutation.target) ||
                 boardInfo.playerBoxBottom?.contains(mutation.target)) {
                 targetIsRelevant = true;
             } else if (boardInfo.boardContainer?.contains(mutation.target)) {
                  // Only check container if direct elements don't match - avoids redundant checks
                 targetIsRelevant = true;
             }

            if (!targetIsRelevant) {
                continue; // Ignore mutations outside our primary observed areas
            }

            // Check for common relevant changes more specifically
            if (mutation.type === 'childList') {
                 // Check if nodes were added/removed specifically to piece/move list containers
                 if (mutation.target === boardInfo.boardElement || mutation.target.closest(boardInfo.selectors.PIECE_SELECTOR) ||
                     mutation.target === boardInfo.moveListContainer || mutation.target.closest(boardInfo.selectors.MOVE_LIST_ROW_SELECTOR) ||
                     mutation.target.closest(boardInfo.selectors.SELECTED_MOVE_SELECTOR)) {
                    // console.log('[Observer DBG] childList change in relevant area:', mutation.target);
                    relevantChangeDetected = true;
                    break;
                }
            }
            if (mutation.type === 'attributes') {
                 // Check attributes on relevant elements only
                 const targetElement = mutation.target;
                 if (targetElement.matches(boardInfo.selectors.PIECE_SELECTOR) && mutation.attributeName === 'style') { // Piece moved (Live Board)
                     // console.log('[Observer DBG] Piece style change:', targetElement);
                     relevantChangeDetected = true;
                     break;
                 }
                 if (targetElement.matches(boardInfo.selectors.PIECE_SELECTOR) && mutation.attributeName === 'class') { // Piece moved (WC Board)
                      // console.log('[Observer DBG] Piece class change:', targetElement);
                     relevantChangeDetected = true;
                     break;
                 }
                 if ((targetElement.matches(boardInfo.selectors.SELECTED_MOVE_NODE_SELECTOR) || targetElement.matches('span.selected') || targetElement.matches(boardInfo.selectors.SELECTED_MOVE_SELECTOR)) && mutation.attributeName === 'class') { // Highlighted move changed
                      // console.log('[Observer DBG] Selected move class change:', targetElement);
                     relevantChangeDetected = true;
                     break;
                 }
                 if (targetElement.matches(boardInfo.selectors.BOARD_ELEMENT_SELECTOR) && ['class', 'orientation'].includes(mutation.attributeName)) { // Board flipped
                     // console.log('[Observer DBG] Board orientation/class change:', targetElement);
                     relevantChangeDetected = true;
                     break;
                 }
                 // Add more specific attribute checks if needed (e.g., for clock updates)
            }
        }

        if (relevantChangeDetected) {
             // console.log('[Observer] Relevant change detected, debouncing FEN calculation...');
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                console.log('[Observer Debounce] Timer fired, running calculateAndSendFEN...');
                calculateAndSendFEN();
            }, DEBOUNCE_DELAY_MS);
        }
    };

    /**
     * Initializes the observer.
     */
    function initializeObserver() {
         if (!boardInfo.boardContainer || !boardInfo.moveListContainer || !boardInfo.boardElement) {
             console.error("[Observer] Cannot initialize - board container, move list, or board element not found.");
             return;
         }

        // Observe fewer, more targeted elements if possible
        const targets = new Set();
        // targets.add(boardInfo.boardContainer); // Container might be too broad, causing excessive triggers
        targets.add(boardInfo.boardElement); // Observe board directly for piece changes / perspective attrs
        targets.add(boardInfo.moveListContainer); // Observe move list for selection changes
        // Observing player boxes might be too much if only clock changes trigger it unnecessarily
        // if (boardInfo.playerBoxTop) targets.add(boardInfo.playerBoxTop);
        // if (boardInfo.playerBoxBottom) targets.add(boardInfo.playerBoxBottom);


        console.log('[Observer] Setting up observer for targets:', Array.from(targets).map(t => t.id || t.className));

        // Refined config: focus on attributes more likely to change position/state
        const config = {
            childList: true, // Needed for pieces appearing/disappearing, moves added
            subtree: true,   // Need subtree for pieces within board and moves within list
            attributes: true,
            attributeFilter: ['class', 'style', 'orientation', 'data-selected'] // Focus on relevant attributes
            // 'data-whole-move-number' might not be needed if childList covers new rows
            // attributeOldValue: false, // Don't need old value
            // characterData: false, // Don't need character data changes (like clock time)
        };

        observer = new MutationObserver(mutationCallback);
        targets.forEach(target => {
             try {
                 observer.observe(target, config);
             } catch (e) {
                  console.error("[Observer] Failed to observe target:", target, e);
             }
        });

        console.log('[Observer] Observer started successfully');
    }

    // --- Analysis Visualization ---

    function connectWebSocket() {
        console.log(`[WebSocket] Attempting to connect to ${WS_URL}...`);

        // Close existing connection if any
        if (ws && ws.readyState !== WebSocket.CLOSED) {
            console.log('[WebSocket] Closing existing connection before reopening.');
            ws.close();
        }

        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('[WebSocket] Connection established.');
            // Optionally send an initial message or identifier if your backend expects one
            // ws.send(JSON.stringify({ type: 'hello', scriptId: 'universal_fen' }));
        };

        ws.onmessage = (event) => {
             console.log('[WebSocket Raw] Message received:', event.data); // Keep raw log active
            try {
                const data = JSON.parse(event.data);

                // Check if the message contains the expected structure for visualization
                 // Adapt this check based on the actual structure your backend sends
                 if (data && data.finalShapes && Array.isArray(data.finalShapes)) { // Focus on finalShapes
                     console.log('[WebSocket Parsed] Received finalShapes data:', data);
                     currentAnalysis = data; // Store the latest analysis shapes
                     renderEngineVisualization(currentAnalysis); // Render the arrows/shapes
                 } else if (data && data.status === 'connected') {
                      console.log('[WebSocket Parsed] Received connection status:', data);
                 }
                 // Add checks for other expected message types if needed
                 else {
                     console.log('[WebSocket Parsed] Received data does not appear to be expected analysis format:', data);
                 }
            } catch (error) {
                console.error('[WebSocket] Failed to parse message data:', error, 'Raw data:', event.data);
            }
        };

        ws.onerror = (error) => {
            console.error('[WebSocket] Error:', error);
            // Consider adding more robust error handling or UI feedback
        };

        ws.onclose = (event) => {
            console.log(`[WebSocket] Connection closed. Code: ${event.code}, Reason: ${event.reason}`);
            // Simple reconnect logic (optional)
            // setTimeout(connectWebSocket, 5000); // Attempt to reconnect after 5 seconds
        };
    }

    function createAnalysisOverlay() {
         if (analysisOverlay && analysisOverlay.parentElement) {
             // console.log('[Viz Overlay] Overlay already exists and is attached.');
             return; // Already exists and attached
         }
         if (!boardInfo.boardElement) {
              console.error("[Viz Overlay] Board element not found, cannot create overlay.");
              return;
         }

         const boardRect = boardInfo.boardElement.getBoundingClientRect();
          // console.log('[Viz Overlay DBG] Board Element Rect:', JSON.stringify(boardRect)); // Reduce noise
          if (!boardRect || boardRect.width <= 0 || boardRect.height <= 0) {
               console.error("[Viz Overlay DBG] Invalid board element dimensions. Cannot create overlay.");
               return;
          }

         // Find a suitable parent for the overlay. Often the board's parentElement works well.
          // Prefer parentElement over boardContainer for more direct positioning relative to board
         const overlayParent = boardInfo.boardElement.parentElement;
         if (!overlayParent) {
              console.error("[Viz Overlay DBG] Suitable overlay parent (boardElement.parentElement) not found.");
              return;
         }
         const parentRect = overlayParent.getBoundingClientRect();
         // console.log('[Viz Overlay DBG] Overlay Parent Element Rect:', JSON.stringify(parentRect)); // Reduce noise
         // console.log('[Viz Overlay DBG] Overlay Parent computed style position:', window.getComputedStyle(overlayParent).position); // Reduce noise

         // Ensure parent can contain absolutely positioned children
         if (window.getComputedStyle(overlayParent).position === 'static') {
              console.log('[Viz Overlay DBG] Setting overlay parent position to relative.');
              overlayParent.style.position = 'relative';
         }

         // --- Create or Re-use SVG Overlay ---
         if (!analysisOverlay || !analysisOverlay.parentElement) {
             console.log('[Viz Overlay] Creating new SVG overlay.');
             analysisOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
             analysisOverlay.style.position = 'absolute';
             analysisOverlay.style.pointerEvents = 'none'; // Allow clicks to pass through
             analysisOverlay.style.zIndex = '5'; // Position above board but below pieces/interaction layers if possible
             analysisOverlay.setAttribute('data-userscript-overlay', 'true'); // Mark for easy identification/cleanup
             overlayParent.appendChild(analysisOverlay);
         } else {
              console.log('[Viz Overlay] Re-using existing SVG overlay.');
         }
         // Always update position and size in case board moved/resized
         analysisOverlay.style.top = `${boardRect.top - parentRect.top}px`; // Position relative to parent
         analysisOverlay.style.left = `${boardRect.left - parentRect.left}px`;
         analysisOverlay.style.width = `${boardRect.width}px`;
         analysisOverlay.style.height = `${boardRect.height}px`;
         analysisOverlay.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`);


         // --- Create or Re-use Label Container ---
         if (!labelContainer || !labelContainer.parentElement) {
              console.log('[Viz Overlay] Creating new label container.');
              labelContainer = document.createElement('div');
              labelContainer.style.position = 'absolute';
              labelContainer.style.pointerEvents = 'none';
              labelContainer.style.zIndex = '6'; // Above SVG arrows
              labelContainer.setAttribute('data-userscript-labels', 'true'); // Mark for easy identification/cleanup
              overlayParent.appendChild(labelContainer);
         } else {
              console.log('[Viz Overlay] Re-using existing label container.');
         }
         // Always update position and size
         labelContainer.style.top = `${boardRect.top - parentRect.top}px`; // Match SVG positioning
         labelContainer.style.left = `${boardRect.left - parentRect.left}px`;
         labelContainer.style.width = `${boardRect.width}px`;
         labelContainer.style.height = `${boardRect.height}px`;

         console.log('[Viz] Analysis overlay and label container created/verified.');
    }

     function clearAnalysisVisuals() {
         if (analysisOverlay) {
             // More efficient clearing
             analysisOverlay.textContent = ''; // Removes all child nodes
         }
         if (labelContainer) {
             labelContainer.textContent = ''; // Removes all child nodes
         }
         // console.log('[Viz Clear] Cleared analysis visuals.'); // Reduce noise
    }

    /**
     * Converts chess square notation to coordinates relative to the board element.
     * THIS IS THE TRICKIEST PART FOR UNIVERSAL SUPPORT.
     * @param {string} square - Chess square (e.g., "e4")
     * @param {boolean} playingAsBlack - Whether board is flipped visually
     * @returns {object|null} Coordinates {x, y} in pixels relative to board top-left, or null.
     */
    function getSquareCoordinates(square, playingAsBlack) {
        if (!boardInfo.boardElement || !square || square.length !== 2) {
             console.warn(`[Coords] Invalid input: square=${square}, boardElement=${!!boardInfo.boardElement}`);
             return null;
        }
        // console.log(`[Coords DBG] getSquareCoordinates called: square='${square}', playingAsBlack=${playingAsBlack}`); // Reduce noise

        const dims = getBoardDimensions();
        if (!dims || dims.squareSize <= 0) {
             console.warn("[Coords] Cannot get valid board dimensions.");
             return null;
        }
        const { squareSize } = dims;

        const fileChar = square[0];
        const rankChar = square[1];
        const algebraicFileIndex = fileChar.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7 (a=0, h=7)
        const algebraicRankNumber = parseInt(rankChar, 10); // 1-8

        if (algebraicFileIndex < 0 || algebraicFileIndex > 7 || isNaN(algebraicRankNumber) || algebraicRankNumber < 1 || algebraicRankNumber > 8) {
             console.warn(`[Coords] Invalid algebraic square parsed: ${square} -> fileIdx=${algebraicFileIndex}, rankNum=${algebraicRankNumber}`);
             return null;
        }

        // Determine the visual file index (0=left, 7=right) based on perspective
        const visualFileIndex = playingAsBlack ? 7 - algebraicFileIndex : algebraicFileIndex;

        // Determine the visual rank index (0=top, 7=bottom) based on perspective
        // Rank 8 is visually top (index 0) for White, bottom (index 7) for Black
        // Rank 1 is visually bottom (index 7) for White, top (index 0) for Black
        const visualRankIndex = playingAsBlack ? algebraicRankNumber - 1 : 8 - algebraicRankNumber;


        // Calculate pixel coordinates (center of the square) relative to board top-left
        const x = (visualFileIndex + 0.5) * squareSize;
        const y = (visualRankIndex + 0.5) * squareSize;

        // console.log(`[Coords DBG] Square: ${square}, playingAsBlack: ${playingAsBlack} => algFileIdx=${algebraicFileIndex}, algRankNum=${algebraicRankNumber} => visFileIdx=${visualFileIndex}, visRankIdx=${visualRankIndex} => X=${x.toFixed(1)}, Y=${y.toFixed(1)}`); // Reduce noise

        return { x, y };
    }

     /**
      * Creates an SVG path for an arrow.
      * @param {object} fromCoords - Starting pixel coordinates {x, y} relative to board
      * @param {object} toCoords - Ending pixel coordinates {x, y} relative to board
      * @param {number} width - Arrow width
      * @param {boolean} isKnight - True for L-shaped knight moves
      * @returns {string} SVG path definition
      */
    function createArrowPath(fromCoords, toCoords, width, isKnight) {
         // Implementation based on Chessground's arrow drawing logic
         if (!fromCoords || !toCoords) return undefined; // Return undefined if coords are missing

         const dx = toCoords.x - fromCoords.x;
         const dy = toCoords.y - fromCoords.y;
         const len = Math.sqrt(dx * dx + dy * dy);
         if (len < 0.01) return undefined; // Avoid division by zero for zero-length arrows

         // Dynamic adjustments based on arrow length maybe? (Keep simple for now)
         const scaleFactor = 1.0; // Math.min(1.0, len / (width * 5)); // Example scaling down for very short arrows

         const arrowWidth = width * 0.75 * scaleFactor;
         const headLength = width * 2 * scaleFactor;
         const headWidth = width * 2 * scaleFactor;

         // Adjust headLength slightly so the tip exactly reaches the target coordinate center
         const effectiveHeadLength = Math.min(headLength, len - arrowWidth / 2); // Prevent head going past start for short arrows

         // Normalize direction vector
         const ndx = dx / len;
         const ndy = dy / len;

         // Perpendicular vector
         const pdx = -ndy;
         const pdy = ndx;

         // Point where head meets shaft (adjust back by effective head length)
         const headBasePointX = toCoords.x - ndx * effectiveHeadLength;
         const headBasePointY = toCoords.y - ndy * effectiveHeadLength;

         // Points for the arrow shaft (rectangle) - Start slightly away from origin center? No, keep at center.
         const shaftPoint1 = { x: fromCoords.x + pdx * arrowWidth / 2, y: fromCoords.y + pdy * arrowWidth / 2 };
         const shaftPoint2 = { x: fromCoords.x - pdx * arrowWidth / 2, y: fromCoords.y - pdy * arrowWidth / 2 };
         const shaftPoint3 = { x: headBasePointX - pdx * arrowWidth / 2, y: headBasePointY - pdy * arrowWidth / 2 };
         const shaftPoint4 = { x: headBasePointX + pdx * arrowWidth / 2, y: headBasePointY + pdy * arrowWidth / 2 };


         // Points for the arrowhead (triangle)
         const headPoint1 = { x: toCoords.x, y: toCoords.y }; // Tip of the arrow at target center
         const headPoint2 = { x: headBasePointX - pdx * headWidth / 2, y: headBasePointY - pdy * headWidth / 2 };
         const headPoint3 = { x: headBasePointX + pdx * headWidth / 2, y: headBasePointY + pdy * headWidth / 2 };

         // SVG Path string (MoveTo, LineTo commands)
         // Use fixed precision to avoid overly long path strings
         const dp = 1; // Decimal places (1 is usually sufficient)
         const path = [
             `M ${shaftPoint1.x.toFixed(dp)} ${shaftPoint1.y.toFixed(dp)}`, // Move to start of shaft side 1
             `L ${shaftPoint2.x.toFixed(dp)} ${shaftPoint2.y.toFixed(dp)}`, // Line to start of shaft side 2
             `L ${shaftPoint3.x.toFixed(dp)} ${shaftPoint3.y.toFixed(dp)}`, // Line to end of shaft side 2 (before head base)
             `L ${headPoint2.x.toFixed(dp)} ${headPoint2.y.toFixed(dp)}`,   // Line to arrowhead base side 2
             `L ${headPoint1.x.toFixed(dp)} ${headPoint1.y.toFixed(dp)}`,   // Line to arrowhead tip
             `L ${headPoint3.x.toFixed(dp)} ${headPoint3.y.toFixed(dp)}`,   // Line to arrowhead base side 1
             `L ${shaftPoint4.x.toFixed(dp)} ${shaftPoint4.y.toFixed(dp)}`, // Line to end of shaft side 1 (before head base)
             `Z` // Close path
         ].join(' ');

         return path;
    }

    /**
     * Draws an arrow on the board using pre-calculated coordinates
     * @param {string} fromSquare - Starting square (e.g., "e2")
     * @param {string} toSquare - Ending square (e.g., "e4")
     * @param {object} fromCoords - Starting coordinates {x, y}
     * @param {object} toCoords - Ending coordinates {x, y} (potentially offset)
     * @param {string} color - Arrow color in hex format
     * @param {number} rank - Move rank for labeling
     * @param {number} [score] - Optional evaluation score.
     * @param {number} [engineIndex] - Optional engine index.
     */
    function drawArrow(fromSquare, toSquare, fromCoords, toCoords, color, rank, score, engineIndex) {
         if (!analysisOverlay || !labelContainer || !fromCoords || !toCoords) {
              console.warn(`[Viz Draw] Cannot draw arrow ${fromSquare}->${toSquare}. Missing overlay, labelContainer, or coords.`, { analysisOverlay: !!analysisOverlay, labelContainer: !!labelContainer, fromCoords, toCoords });
              return;
         }
         // console.log(`[Viz Draw DBG] Checking overlay elements. analysisOverlay valid? ${!!analysisOverlay?.parentElement}, labelContainer valid? ${!!labelContainer?.parentElement}`); // Reduce noise

         const isKnight = isKnightMove(fromSquare, toSquare);
         const arrowPathData = createArrowPath(fromCoords, toCoords, ARROW_WIDTH, isKnight);
         // console.log(`[DEBUG Viz Draw] Arrow: ${fromSquare}->${toSquare}, Color: ${color}, PathData: ${arrowPathData}, FromCoords:`, fromCoords, 'ToCoords:', toCoords); // Reduce noise

         // Ensure path data is valid before creating element
         if (!arrowPathData) {
             console.warn(`[Viz Draw DBG] Skipping arrow ${fromSquare}->${toSquare} due to invalid path data.`);
             return;
         }

         const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
         path.setAttribute('d', arrowPathData);
         path.setAttribute('fill', color);
         path.setAttribute('opacity', ARROW_OPACITY);
         path.setAttribute('data-arrow-from', fromSquare); // Add data attributes for debugging/identification
         path.setAttribute('data-arrow-to', toSquare);
         analysisOverlay.appendChild(path);

         // Add label
         if (SHOW_LABELS) {
            const label = document.createElement('div');
             label.style.position = 'absolute';
             // Position label closer to the arrow tip
             const labelOffsetRatio = 0.85; // Place label 85% along the arrow vector from start
             const labelX = fromCoords.x + (toCoords.x - fromCoords.x) * labelOffsetRatio;
             const labelY = fromCoords.y + (toCoords.y - fromCoords.y) * labelOffsetRatio;
             label.style.left = `${labelX.toFixed(1)}px`;
             label.style.top = `${labelY.toFixed(1)}px`;
             label.style.transform = 'translate(-50%, -50%)'; // Center label on point
             label.style.color = 'black'; // Contrasting border/text shadow would be better
             label.style.textShadow = '0 0 2px white, 0 0 2px white, 0 0 2px white'; // Simple white outline
             label.style.backgroundColor = `${color}AA`; // Use arrow color with some transparency
             label.style.padding = '0px 2px'; // Smaller padding
             label.style.borderRadius = '2px'; // Smaller radius
             label.style.fontSize = '9px'; // Smaller font
             label.style.fontWeight = 'bold';
             label.style.pointerEvents = 'none';
             label.style.zIndex = '10'; // Ensure labels are above arrows
             label.textContent = `${rank}`; // Display rank
             // Score display might be less useful with direct shapes, keep simple
             // if (score !== undefined) {
             //     label.textContent += ` (${formatScore(score)})`;
             // }
             label.setAttribute('data-label-for', `${fromSquare}-${toSquare}`); // Link label to arrow
            labelContainer.appendChild(label);
         }
    }


    /**
     * Renders engine visualization data as SVG overlays
     * @param {Object} visualization - The complete engine visualization data from WebSocket, expected to have a `finalShapes` property.
     */
    function renderEngineVisualization(visualization) {
        // console.log('[Viz Render] Received visualization data:', JSON.stringify(visualization)); // Reduce noise

        if (!boardInfo.boardElement) {
            console.warn("[Viz Render] Board element not found, cannot render.");
            return;
        }
        if (!visualization || !visualization.finalShapes || !Array.isArray(visualization.finalShapes)) {
            console.warn("[Viz Render] Invalid or missing finalShapes data in visualization object:", visualization);
            clearAnalysisVisuals(); // Clear old visuals if data is bad
            return;
        }

        createAnalysisOverlay(); // Ensure overlay exists and is positioned correctly
        clearAnalysisVisuals(); // Clear previous visuals

        const { finalShapes } = visualization; // Directly use finalShapes
        const { playingAsBlack } = determinePlayerColor(); // Needed for coordinate mapping
        console.log(`[Viz Render DRAWING] Using playingAsBlack=${playingAsBlack} for coordinate calculations.`);

        if (finalShapes.length === 0) {
             console.log("[Viz Render] No shapes received to draw.");
            return; // Nothing to draw
        }

        console.log(`[Viz Render] Processing ${finalShapes.length} shapes received.`);
        // console.log(`[Viz Render DBG] First shape raw data:`, JSON.stringify(finalShapes[0])); // Reduce noise

        // Process shapes directly: Calculate coordinates and prepare for drawing
        const processedShapes = finalShapes.map((shape, index) => {
            // Minimal validation
            if (!shape.from || !shape.to || !shape.color) {
                console.warn(`[Viz Render] Skipping invalid shape at index ${index}:`, shape);
                return null;
            }
             // console.log(`[Viz Render DBG Shape ${index+1}] Calculating coords for ${shape.from}->${shape.to} using playingAsBlack=${playingAsBlack}`); // Reduce noise
            const fromCoords = getSquareCoordinates(shape.from, playingAsBlack);
            const toCoords = getSquareCoordinates(shape.to, playingAsBlack);
             // console.log(`[Viz Render DBG Shape ${index+1}] Result Coords: from=${JSON.stringify(fromCoords)}, to=${JSON.stringify(toCoords)}`); // Reduce noise


            if (!fromCoords || !toCoords) {
                console.warn(`[Viz Render] Skipping shape due to invalid coords: From: ${shape.from} (${JSON.stringify(fromCoords)}), To: ${shape.to} (${JSON.stringify(toCoords)})`);
                return null;
            }

            return {
                ...shape, // Include original properties like color, lineWidth
                fromCoords: fromCoords,
                toCoords: toCoords,
                rank: index + 1, // Simple ranking based on order received
                engineIndex: 0 // Placeholder if needed
            };
        }).filter(shape => shape !== null); // Remove nulls from invalid shapes
        // console.log('[Viz Render] Processed shapes:', JSON.stringify(processedShapes)); // Reduce noise

        if (processedShapes.length === 0) {
            console.warn("[Viz Render] No valid shapes to draw after processing.");
            return;
        }

        // --- Optional: Arrow Offsetting (Adapted for direct shapes) ---
        // Group processed shapes by destination and origin for offsetting
        const shapesByDestination = {};
        const shapesByOrigin = {};
        processedShapes.forEach(shape => {
            // Group by destination
            if (!shapesByDestination[shape.to]) shapesByDestination[shape.to] = [];
            shapesByDestination[shape.to].push(shape);
            // Group by origin
            if (!shapesByOrigin[shape.from]) shapesByOrigin[shape.from] = [];
            shapesByOrigin[shape.from].push(shape);
        });

        // Apply offsets (reuse existing offset logic if applicable)
        const DEST_OFFSET_DISTANCE = ARROW_WIDTH * 0.6;
        Object.values(shapesByDestination).forEach(shapeGroup => {
             if (shapeGroup.length > 1) {
                const angleStep = (Math.PI / 2) / (shapeGroup.length -1); // Spread over 90 degrees
                const baseAngle = -(Math.PI / 4); // Start from -45 degrees
                shapeGroup.sort((a, b) => a.rank - b.rank); // Offset based on rank/order
                shapeGroup.forEach((shape, idx) => {
                    // Don't offset the first arrow (best move)? Or apply to all? Apply to all for consistency.
                    const angle = baseAngle + idx * angleStep;
                    shape.toCoords.x += Math.cos(angle) * DEST_OFFSET_DISTANCE;
                    shape.toCoords.y += Math.sin(angle) * DEST_OFFSET_DISTANCE;
                });
            }
        });

        const ORIGIN_OFFSET_DISTANCE = ARROW_WIDTH * 0.3;
         Object.values(shapesByOrigin).forEach(shapeGroup => {
            if (shapeGroup.length > 1) {
                const angleStep = (Math.PI / 2) / (shapeGroup.length -1);
                const baseAngle = -(Math.PI / 4);
                shapeGroup.sort((a, b) => a.rank - b.rank);
                shapeGroup.forEach((shape, idx) => {
                    const angle = baseAngle + idx * angleStep;
                    shape.fromCoords.x += Math.cos(angle) * ORIGIN_OFFSET_DISTANCE;
                    shape.fromCoords.y += Math.sin(angle) * ORIGIN_OFFSET_DISTANCE;
                });
            }
        });
        // --- End Optional Offsetting ---

        // --- Draw Arrows ---
        // console.log(`[Viz Render] Drawing ${processedShapes.length} arrows... Checking overlay elements: analysisOverlay valid? ${!!analysisOverlay?.parentElement}, labelContainer valid? ${!!labelContainer?.parentElement}`); // Reduce noise
        processedShapes.forEach(shape => {
             // Use shape properties directly.
             drawArrow(
                shape.from,
                shape.to,
                shape.fromCoords,
                shape.toCoords,
                shape.color,
                shape.rank, // Use derived rank
                undefined, // Score might not be available, pass undefined
                shape.engineIndex // Use derived index
            );
        });

        console.log("[Viz Render] Arrow drawing complete.");
    }

    // --- Utility Functions (isKnightMove, formatScore, getScoreGradientColor) ---
    /**
     * Checks if a move is a knight move based on square distance.
     * @param {string} fromSq - e.g., "g1"
     * @param {string} toSq - e.g., "f3"
     * @returns {boolean}
     */
    function isKnightMove(fromSq, toSq) {
        if (!fromSq || !toSq || fromSq.length !== 2 || toSq.length !== 2) return false;
        const f1 = fromSq.charCodeAt(0) - 'a'.charCodeAt(0);
        const r1 = parseInt(fromSq[1], 10) - 1;
        const f2 = toSq.charCodeAt(0) - 'a'.charCodeAt(0);
        const r2 = parseInt(toSq[1], 10) - 1;

        const dx = Math.abs(f1 - f2);
        const dy = Math.abs(r1 - r2);

        return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
    }

    function formatScore(score) {
        if (typeof score === 'number') {
            return (score / 100).toFixed(2); // Assuming score is in centipawns
        }
        // Handle mate scores (e.g., M2, M-3)
        if (typeof score === 'string' && score.startsWith('M')) {
             return score;
        }
        return '?';
    }


    // --- Script Execution ---
    // Delay initialization slightly to ensure page elements (especially web components) are ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(initializeScript, INIT_DELAY_MS));
    } else {
        setTimeout(initializeScript, INIT_DELAY_MS);
    }

    // --- Cleanup ---
    window.addEventListener('beforeunload', () => {
        if (observer) {
            observer.disconnect();
            console.log('[FEN Sender] Observer disconnected');
        }
        clearTimeout(debounceTimer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
            console.log('[WebSocket] Connection closed on page unload.');
        }
        // Remove buttons and overlay
        const controlsContainer = document.getElementById('userscript-fen-controls');
        if (controlsContainer) controlsContainer.remove();
        if (analysisOverlay) analysisOverlay.remove();
        if (labelContainer) labelContainer.remove();
    });

})();
