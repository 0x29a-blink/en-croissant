// ==UserScript==
// @name        Chess.com Universal Board Sync
// @namespace   Violentmonkey Scripts
// @match       *://*.chess.com/*
// @grant       GM_xmlhttpRequest
// @connect     localhost
// @connect     127.0.0.1
// @version     1.1
// @author      0x29a-blink
// @description Extracts board state and move list from Chess.com, sends to backend, and listens for overlays. UI and overlays coming soon.
// ==/UserScript==

(function() {
  'use strict';

  // --- Config ---
  const BACKEND_URL = 'http://127.0.0.1:3030/fen';
  const WS_URL = 'ws://127.0.0.1:3030/ws';
  const DEBOUNCE_MS = 150;
  const VARIANTS = ['standard', 'chess960']; // Extend as needed

  // --- State ---
  let lastSent = { fen: '', moveList: '', variant: '' };
  let ws = null;
  let debounceTimer = null;
  let currentVariant = VARIANTS[0];

  // --- Logger System ---
  const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
  let currentLogLevelIdx = 3; 
  
  function log(level, ...args) {
    const idx = LOG_LEVELS.indexOf(level);
    if (idx <= currentLogLevelIdx) {
      // Use console method if available
      (console[level] || console.log)(`[BoardSync][${level.toUpperCase()}]`, ...args);
    }
  }

  function setLogLevel(level) {
    const idx = LOG_LEVELS.indexOf(level);
    if (idx !== -1) currentLogLevelIdx = idx;
    log('info', `Log level set to: ${level}`);
    updateLogLevelButton();
  }

  function cycleLogLevel() {
    currentLogLevelIdx = (currentLogLevelIdx + 1) % LOG_LEVELS.length;
    log('info', `Cycled log level to: ${LOG_LEVELS[currentLogLevelIdx]}`);
    updateLogLevelButton();
  }

  function createLogLevelButton() {
    let btn = document.getElementById('board-sync-log-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'board-sync-log-btn';
      btn.style.position = 'fixed';
      btn.style.bottom = '10px';
      btn.style.left = '10px';
      btn.style.zIndex = 10001;
      btn.style.padding = '4px 8px';
      btn.style.fontSize = '12px';
      btn.style.background = '#222';
      btn.style.color = '#fff';
      btn.style.border = '1px solid #888';
      btn.style.borderRadius = '4px';
      btn.style.opacity = '0.8';
      btn.style.cursor = 'pointer';
      btn.title = 'Cycle log level';
      btn.addEventListener('click', cycleLogLevel);
      document.body.appendChild(btn);
    }
    updateLogLevelButton();
  }

  function updateLogLevelButton() {
    const btn = document.getElementById('board-sync-log-btn');
    if (btn) btn.textContent = `Log: ${LOG_LEVELS[currentLogLevelIdx]}`;
  }

  // --- SPA/Board Detection Support ---
  let boardInitTimeout = null;
  let lastBoardType = null;

  function tryInitBoardSync(force) {
    const type = detectBoardType();
    if (type !== 'UNKNOWN' && (force || type !== lastBoardType)) {
      log('info', `Detected board type: ${type}. Initializing BoardSync.`);
      lastBoardType = type;
      initBoardSync();
    } else if (type === 'UNKNOWN') {
      log('debug', 'No board detected yet.');
    }
  }

  function observeBodyForBoard() {
    const observer = new MutationObserver(() => {
      clearTimeout(boardInitTimeout);
      boardInitTimeout = setTimeout(() => tryInitBoardSync(false), 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function initBoardSync() {
    createUI();
    setupObserver();
    connectWebSocket();
    onBoardChange();
  }

  // --- Board & Move Extraction ---
  function detectBoardType() {
    if (document.querySelector('wc-chess-board')) return 'WC_BOARD';
    if (document.querySelector('.TheBoard-layers')) return 'LIVE_BOARD';
    return 'UNKNOWN';
  }

  function extractBoardData() {
    const type = detectBoardType();
    log('debug', 'Detected board type:', type);
    let fen = '', pieces = {}, moveList = [];
    let boardLayout = null;
    let files = 8, ranks = 8; // Default

    if (type === 'WC_BOARD' || type === 'WC_BOARD_COMPONENT') {
      const wcBoard = document.querySelector('wc-chess-board');
      if (wcBoard) {
        // Try to detect board size dynamically (future-proof)
        // For now, default to 8x8
        files = 8; ranks = 8;
        // Extract pieces from within wc-chess-board
        const pieceElements = wcBoard.querySelectorAll('.piece[class*="square-"]');
        log('debug', `Found ${pieceElements.length} piece elements in wc-chess-board.`);
        pieceElements.forEach(el => {
          const match = Array.from(el.classList).find(cls => cls.startsWith('square-'));
          if (match && match.length === 9) {
            const file = String.fromCharCode('a'.charCodeAt(0) + parseInt(match[7], 10) - 1);
            const rank = match[8];
            const pieceClass = Array.from(el.classList).find(cls => cls.length === 2 && /[wb][pnbrqk]/.test(cls));
            if (pieceClass) {
              // Normalize to 'wK', 'wR', etc.
              pieces[`${file}${rank}`] = pieceClass[0] + pieceClass[1].toUpperCase();
            }
          }
        });
        log('debug', 'Extracted pieces:', pieces);
      } else {
        log('warn', 'wc-chess-board not found for piece extraction.');
      }
      // Extract move list as SAN from wc-simple-move-list
      const moveListContainer = document.querySelector('wc-simple-move-list');
      if (moveListContainer) {
        const moveNodes = moveListContainer.querySelectorAll('.node .node-highlight-content');
        log('debug', `Found ${moveNodes.length} move nodes in wc-simple-move-list.`);
        moveNodes.forEach(el => {
          const san = el.textContent.trim();
          if (san) moveList.push(san);
        });
      } else {
        log('warn', 'wc-simple-move-list not found for move extraction.');
      }
      fen = reconstructFENFromPieces(pieces, moveList, currentVariant);
      log('info', 'Extracted FEN:', fen);
      log('info', 'Extracted move list:', moveList);
    } else if (type === 'LIVE_BOARD') {
      // Try to detect board size dynamically (future-proof)
      // For now, default to 8x8
      files = 8; ranks = 8;
      const liveBoard = document.querySelector('.TheBoard-layers');
      if (liveBoard) {
        // Extract pieces using pixel mapping
        const pieceElements = document.querySelectorAll('.TheBoard-pieces .piece[data-piece][style*="translate"]');
        log('debug', `Found ${pieceElements.length} piece elements in LIVE_BOARD.`);
        // Get board dimensions
        const boardRect = liveBoard.getBoundingClientRect();
        const boardSize = Math.min(boardRect.width, boardRect.height);
        const squareSize = boardSize / files;
        pieceElements.forEach(el => {
          const piece = el.getAttribute('data-piece');
          const transform = el.style.transform;
          const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)/);
          if (piece && match && squareSize > 0) {
            const x = parseFloat(match[1]);
            const y = parseFloat(match[2]);
            // Map pixel to file/rank
            let fileIdx = Math.floor(x / squareSize);
            let rankIdx = Math.floor(y / squareSize);
            // Adjust for board orientation if needed (future)
            if (fileIdx >= 0 && fileIdx < files && rankIdx >= 0 && rankIdx < ranks) {
              const file = String.fromCharCode('a'.charCodeAt(0) + fileIdx);
              const rank = ranks - rankIdx;
              pieces[`${file}${rank}`] = piece;
            }
          }
        });
      } else {
        log('warn', 'LIVE_BOARD .TheBoard-layers not found for piece extraction.');
      }
      // Extract move list as SAN
      const moveListContainer = document.querySelector('.moves-moves-list, .move-list-wrapper');
      if (moveListContainer) {
        const moveNodes = moveListContainer.querySelectorAll('.moves-table-cell.moves-move, .move-text');
        log('debug', `Found ${moveNodes.length} move nodes in LIVE_BOARD.`);
        moveNodes.forEach(el => {
          const san = el.textContent.trim();
          if (san) moveList.push(san);
        });
      } else {
        log('warn', 'LIVE_BOARD move list container not found.');
      }
      fen = ''; // Not directly available; backend can reconstruct from pieces/moves
      log('info', 'Extracted move list:', moveList);
    }

    // --- Dynamic Board Layout Structure ---
    const squares = [];
    for (let r = ranks; r >= 1; r--) {
      const rankArr = [];
      for (let f = 0; f < files; f++) {
        const fileChar = String.fromCharCode('a'.charCodeAt(0) + f);
        const square = `${fileChar}${r}`;
        const piece = pieces[square] || null;
        rankArr.push({ square, piece });
      }
      squares.push(rankArr);
    }
    boardLayout = { files, ranks, squares };
    log('debug', `Board layout for ${files}x${ranks}:`, boardLayout);

    return { fen, pieces, moveList, variant: currentVariant, boardLayout };
  }

  // Helper: Reconstruct FEN from pieces (for WC_BOARD)
  function reconstructFENFromPieces(pieces, moveList, variant) {
    // Build 8x8 board
    const board = Array(8).fill(null).map(() => Array(8).fill(''));
    Object.entries(pieces).forEach(([sq, pc]) => {
      const file = sq.charCodeAt(0) - 'a'.charCodeAt(0);
      const rank = 8 - parseInt(sq[1], 10);
      if (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
        // Convert to FEN char
        const color = pc[0], type = pc[1];
        const fenChar = color === 'w' ? type.toUpperCase() : type.toLowerCase();
        board[rank][file] = fenChar;
      }
    });
    // Piece placement
    let fenRows = board.map(row => {
      let str = '', empty = 0;
      row.forEach(cell => {
        if (cell) {
          if (empty) { str += empty; empty = 0; }
          str += cell;
        } else {
          empty++;
        }
      });
      if (empty) str += empty;
      return str;
    });
    // Active color (guess from move list length)
    const activeColor = moveList.length % 2 === 0 ? 'w' : 'b';
    // Castling, en passant, halfmove, fullmove (basic defaults)
    const castling = '-';
    const enPassant = '-';
    const halfmove = '0';
    const fullmove = Math.floor(moveList.length / 2) + 1;
    return `${fenRows.join('/')} ${activeColor} ${castling} ${enPassant} ${halfmove} ${fullmove}`;
  }

  // --- Backend Communication ---
  function sendBoardData(data) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: BACKEND_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data),
      onload: function(response) {
        log('info', 'POST Success:', response.status, response.responseText);
      },
      onerror: function(response) {
        log('error', 'POST Error:', response.status, response.statusText);
      }
    });
  }

  // --- WebSocket for Overlays ---
  function connectWebSocket() {
    if (ws) ws.close();
    ws = new WebSocket(WS_URL);
    ws.onopen = () => log('info', 'WebSocket connected');
    ws.onmessage = (event) => {
      // TODO: Overlay rendering logic will go here
      log('debug', 'WS message:', event.data);
    };
    ws.onclose = () => setTimeout(connectWebSocket, 5000);
    ws.onerror = (e) => log('error', 'WS error:', e);
  }

  // --- Debounced Observer ---
  function onBoardChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const data = extractBoardData();
      // Only send if changed
      if (data.fen !== lastSent.fen || JSON.stringify(data.moveList) !== lastSent.moveList || data.variant !== lastSent.variant) {
        sendBoardData(data);
        lastSent = { fen: data.fen, moveList: JSON.stringify(data.moveList), variant: data.variant };
      }
    }, DEBOUNCE_MS);
  }

  function setupObserver() {
    // TODO: Use robust selectors from previous script
    const boardArea = document.querySelector('wc-chess-board') || document.querySelector('.TheBoard-layers');
    if (!boardArea) return;
    const observer = new MutationObserver(onBoardChange);
    observer.observe(boardArea, { childList: true, subtree: true, attributes: true });
  }

  // --- UI Controls (Scaffold) ---
  function createUI() {
    // TODO: Add buttons for New Game, Variant override, Manual send, Overlay toggle
    // Scaffold only
    log('info', 'UI scaffolded (controls coming soon)');
    createLogLevelButton();
  }

  // --- Main Init ---
  function mainInit() {
    createLogLevelButton();
    observeBodyForBoard();
    tryInitBoardSync(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mainInit);
  } else {
    mainInit();
  }

})();
