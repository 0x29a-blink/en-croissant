// ==UserScript==
// @name        Chess.com Universal Board Sync
// @namespace   Violentmonkey Scripts
// @match       *://*.chess.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @connect     localhost
// @connect     127.0.0.1
// @version     1.2.0
// @author      0x29a-blink, En Croissant Team
// @description Extracts board state and move list from Chess.com, sends to backend, and listens for overlays. Supports all chess variants.
// @homepage    https://github.com/openingnow/en-croissant
// ==/UserScript==

(function() {
  'use strict';

  // --- Config ---
  const BACKEND_URL = 'http://127.0.0.1:3030/fen';
  const WS_URL = 'ws://127.0.0.1:3030/ws';
  const DEBOUNCE_MS = 150;
  const SUPPORTED_VARIANTS = [
    { value: 'standard', label: 'Standard Chess' },
    { value: 'chess960', label: 'Chess960' },
    { value: 'crazyhouse', label: 'Crazyhouse' },
    { value: 'kingOfTheHill', label: 'King of the Hill' },
    { value: 'threeCheck', label: 'Three-check' },
    { value: 'antichess', label: 'Antichess' },
    { value: 'atomic', label: 'Atomic' },
    { value: 'horde', label: 'Horde' },
    { value: 'racingKings', label: 'Racing Kings' }
  ];

  // --- State ---
  let lastSent = { pieces: {}, moveList: [], variant: '' };
  let ws = null;
  let debounceTimer = null;
  let manualVariantMode = GM_getValue('manualVariantMode', false);
  let currentVariant = GM_getValue('currentVariant', 'standard');
  let variantDetectionLocked = false;
  let uiVisible = GM_getValue('uiVisible', true);
  
  // Current game state
  let currentGame = GM_getValue('currentGame', {
    id: null,
    startPosition: null,
    moveList: [],
    variant: 'standard',
    lastUpdated: 0
  });

  // --- Logger System ---
  const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'advanced'];
  let currentLogLevelIdx = GM_getValue('logLevel', 2); // Default to 'info'

  function log(level, ...args) {
    const idx = LOG_LEVELS.indexOf(level);
    if (idx <= currentLogLevelIdx) {
      // Use console method if available
      (console[level] || console.log)(`[EnCroissant][${level.toUpperCase()}]`, ...args);
    }
  }

  function setLogLevel(level) {
    const idx = LOG_LEVELS.indexOf(level);
    if (idx !== -1) {
      currentLogLevelIdx = idx;
      GM_setValue('logLevel', idx);
      log('info', `Log level set to: ${level}`);
      updateLogLevelButton();
    }
  }

  function cycleLogLevel() {
    currentLogLevelIdx = (currentLogLevelIdx + 1) % LOG_LEVELS.length;
    GM_setValue('logLevel', currentLogLevelIdx);
    log('info', `Cycled log level to: ${LOG_LEVELS[currentLogLevelIdx]}`);
    updateLogLevelButton();
  }

  function createLogLevelButton() {
    let btn = document.getElementById('ec-log-level-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'ec-log-level-btn';
      btn.className = 'ec-ui-component';
      btn.style.position = 'fixed';
      btn.style.bottom = '10px';
      btn.style.left = '10px';
      btn.style.zIndex = '10001';
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
    const btn = document.getElementById('ec-log-level-btn');
    if (btn) btn.textContent = `Log: ${LOG_LEVELS[currentLogLevelIdx]}`;
  }

  // --- Game State Management ---
  
  function saveGameState() {
    GM_setValue('currentGame', currentGame);
    log('debug', 'Game state saved to local storage');
  }

  function detectNewGame(pieces, moveList) {
    // If no current game exists, this is definitely a new game
    if (!currentGame.id) {
      log('debug', 'No current game exists, creating new game');
      return true;
    }
    
    // Method 1: Check URL change for game ID
    const currentUrl = window.location.href;
    const gameIdFromUrl = extractGameIdFromUrl(currentUrl);
    const storedGameId = currentGame.gameIdFromUrl;
    
    if (gameIdFromUrl && storedGameId && gameIdFromUrl !== storedGameId) {
      log('debug', `Game ID in URL changed from ${storedGameId} to ${gameIdFromUrl}, detecting as new game`);
      return true;
    }
    
    // Method 2: Move list length decreased significantly or reset to zero
    if (currentGame.moveList.length > 5 && moveList.length < 2) {
      log('debug', 'Move list reset or decreased significantly, likely a new game');
      return true;
    }
    
    // Method 3: Initial position changed significantly (only check if position is standard-like)
    if (currentGame.startPosition && moveList.length < 3) {
      const differencesCount = countPositionDifferences(currentGame.startPosition, pieces);
      // More strict: only if almost all pieces changed (16+ differences out of 32 pieces)
      if (differencesCount > 16) {
        log('debug', `Position changed significantly (${differencesCount} differences), likely a new game`);
        return true;
      }
    }
    
    // Method 4: Check for standard initial position
    if (isStandardInitialPosition(pieces) && currentGame.moveList.length > 10) {
      log('debug', 'Detected standard initial position after moves were made, likely a new game');
      return true;
    }
    
    // Method 5: Check for significant move list change (skips being triggered in middle of game)
    // Only if current game already has several moves
    if (currentGame.moveList.length > 5) {
      // Compare first few moves to detect completely different games
      const currentFirstMoves = currentGame.moveList.slice(0, 5).join(',');
      const newFirstMoves = moveList.slice(0, 5).join(',');
      
      if (moveList.length > 5 && currentFirstMoves !== newFirstMoves) {
        log('debug', 'First moves changed completely, likely a new game');
        return true;
      }
    }
    
    // Method 6: Significant time passed since last update (very long duration)
    const now = Date.now();
    if (now - currentGame.lastUpdated > 15 * 60 * 1000) { // 15 minutes instead of 5
      log('debug', 'Significant time passed since last update, treating as new game');
      return true;
    }
    
    return false;
  }

  // Helper function to extract game ID from URL
  function extractGameIdFromUrl(url) {
    // Chess.com URLs typically have a game ID in the format /game/live/12345678
    const match = url.match(/\/game\/(?:live|daily)\/(\d+)/);
    return match ? match[1] : null;
  }

  // Helper function to check if the position resembles a standard initial position
  function isStandardInitialPosition(pieces) {
    // Check for key pieces in standard initial position
    const keyPositions = {
      'a1': 'wR', 'e1': 'wK', 'a8': 'bR', 'e8': 'bK',
      'b1': 'wN', 'g1': 'wN', 'b8': 'bN', 'g8': 'bN'
    };
    
    // Count how many key pieces are in expected positions
    let matchCount = 0;
    for (const [square, expectedPiece] of Object.entries(keyPositions)) {
      if (pieces[square] === expectedPiece) {
        matchCount++;
      }
    }
    
    // If most key pieces match (6+ out of 8), it's likely a standard position
    return matchCount >= 6;
  }

  function countPositionDifferences(positionA, positionB) {
    let count = 0;
    
    // Check pieces in position A that are different in B
    for (const [square, piece] of Object.entries(positionA)) {
      if (!positionB[square] || positionB[square] !== piece) {
        count++;
      }
    }
    
    // Check pieces in position B that aren't in A or are different
    for (const [square, piece] of Object.entries(positionB)) {
      if (!positionA[square] || positionA[square] !== piece) {
        count++;
      }
    }
    
    return count / 2; // Divide by 2 since we counted each difference twice
  }

  function startNewGame(pieces, moveList, variant) {
    currentGame = {
      id: Date.now().toString(),
      gameIdFromUrl: extractGameIdFromUrl(window.location.href), // Store the game ID from URL
      startPosition: { ...pieces },
      moveList: [...moveList],
      variant: variant,
      lastUpdated: Date.now()
    };
    
    log('info', 'New game created with ID:', currentGame.id);
    saveGameState();
    
    // Send new game notification to backend
    sendNewGameNotification();
    
    return currentGame;
  }

  function updateCurrentGame(pieces, moveList) {
    currentGame.moveList = [...moveList];
    currentGame.lastUpdated = Date.now();
    saveGameState();
  }

  function sendNewGameNotification() {
    const data = {
      type: 'new_game',
      gameId: currentGame.id,
      startPosition: currentGame.startPosition,
      variant: currentGame.variant,
      timestamp: Date.now()
    };
    
    // Use WebSocket if connected
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      log('info', 'Sent new game notification via WebSocket');
    } else {
      // Use HTTP fallback
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${BACKEND_URL}/new_game`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        onload: function(response) {
          log('info', 'New game notification sent successfully:', response.status);
        },
        onerror: function(response) {
          log('error', 'Error sending new game notification:', response.status);
        }
      });
    }
  }

  // --- Variant Detection and Management ---
  
  function setVariant(variant, isManual = false) {
    if (SUPPORTED_VARIANTS.some(v => v.value === variant)) {
      const oldVariant = currentVariant;
      currentVariant = variant;
      GM_setValue('currentVariant', variant);
      
      if (isManual) {
        manualVariantMode = true;
        GM_setValue('manualVariantMode', true);
        variantDetectionLocked = true;
        log('info', `Variant manually set to ${variant} (detection locked)`);
      } else if (manualVariantMode) {
        // If we're in manual mode and getting an automatic detection,
        // notify but don't change unless it's different
        if (variant !== currentVariant) {
          showVariantSuggestion(variant);
        }
      } else {
        log('info', `Variant automatically detected as ${variant}`);
      }
      
      if (oldVariant !== variant) {
        onBoardChange(); // Force update if variant changed
      }
      
      updateVariantSelector();
    }
  }

  function detectChessVariant() {
    // Skip detection if in manual mode
    if (manualVariantMode && variantDetectionLocked) {
      log('debug', 'Manual variant mode active, using:', currentVariant);
      return currentVariant;
    }
    
    try {
      log('debug', '===== Starting chess variant detection =====');
      
      // Method 0: Special case for specific URLs
      const url = window.location.href;
      log('debug', 'Checking URL:', url);
      
      // Computer play URL is a special case - almost always standard chess
      if (url.includes('/play/computer')) {
        log('debug', 'Computer play URL detected, assuming standard chess');
        return 'standard';
      }
      
      // Play online URL is a special case - should be standard until explicitly selected otherwise
      if (url.includes('/play/online')) {
        log('debug', 'Play online URL detected, assuming standard chess until game starts');
        return 'standard';
      }
      
      // Method 1: Check URL for variant indicators
      if (url.includes('/variants/chess960')) {
        log('debug', 'URL indicates Chess960');
        return 'chess960';
      }
      if (url.includes('/variants/crazyhouse')) {
        log('debug', 'URL indicates Crazyhouse');
        return 'crazyhouse';
      }
      if (url.includes('/variants/kingofthehill')) {
        log('debug', 'URL indicates King of the Hill');
        return 'kingOfTheHill';
      }
      if (url.includes('/variants/threecheck')) {
        log('debug', 'URL indicates Three-check');
        return 'threeCheck';
      }
      if (url.includes('/variants/antichess')) {
        log('debug', 'URL indicates Antichess');
        return 'antichess';
      }
      if (url.includes('/variants/atomic')) {
        log('debug', 'URL indicates Atomic');
        return 'atomic';
      }
      if (url.includes('/variants/horde')) {
        log('debug', 'URL indicates Horde');
        return 'horde';
      }
      if (url.includes('/variants/racingkings')) {
        log('debug', 'URL indicates Racing Kings');
        return 'racingKings';
      }
      
      // Method 2: Check page content - look for variant-specific text
      // BUT only in relevant game context, not in navigation/option menus
      log('debug', 'Checking page content for variant indicators');
      
      // Get text only from game-relevant areas, not from menus
      let gameAreaText = '';
      
      // Try to find the game area container
      const gameContainer = document.querySelector('.board-layout-main, .board-container, .game-controls, .game-review-container');
      if (gameContainer) {
        gameAreaText = gameContainer.textContent || '';
        log('debug', 'Found game area container, examining text in context');
      } else {
        // Fall back to a more restricted body text analysis
        // We intentionally avoid menus and sidebars where variant options might be listed
        const boardElement = document.querySelector('wc-chess-board, .board');
        if (boardElement) {
          // Get the parent elements going up to 3 levels to capture related game text
          let parent = boardElement.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            gameAreaText += parent.textContent || '';
            parent = parent.parentElement;
          }
          log('debug', 'Using text from board element and parents');
        }
      }
      
      // Use gameAreaText if we found content, otherwise use a more limited body text
      const checkText = gameAreaText || document.body.textContent || '';
      log('debug', 'Checking content text length:', checkText.length);
      
      // More precise detection - check for variant mentions in context
      const variantTextRegex = {
        chess960: /\b(Chess\s*960|Fischer\s*Random)\b.*\bgame\b/i,
        crazyhouse: /\bCrazyhouse\b.*\bgame\b/i,
        kingOfTheHill: /\bKing\s*of\s*the\s*Hill\b.*\bgame\b/i,
        threeCheck: /\b(Three\s*-?\s*check|3\s*-?\s*check)\b.*\bgame\b/i,
        antichess: /\bAntichess\b.*\bgame\b/i,
        atomic: /\bAtomic\b.*\bgame\b/i,
        horde: /\bHorde\b.*\bgame\b/i,
        racingKings: /\bRacing\s*Kings\b.*\bgame\b/i
      };
      
      // Check for variants using more precise context
      if (variantTextRegex.chess960.test(checkText)) {
        log('debug', 'Page content indicates active Chess960 game');
        return 'chess960';
      }
      if (variantTextRegex.crazyhouse.test(checkText)) {
        log('debug', 'Page content indicates active Crazyhouse game');
        return 'crazyhouse';
      }
      if (variantTextRegex.kingOfTheHill.test(checkText)) {
        log('debug', 'Page content indicates active King of the Hill game');
        return 'kingOfTheHill';
      }
      if (variantTextRegex.threeCheck.test(checkText)) {
        log('debug', 'Page content indicates active Three-check game');
        return 'threeCheck';
      }
      if (variantTextRegex.antichess.test(checkText)) {
        log('debug', 'Page content indicates active Antichess game');
        return 'antichess';
      }
      if (variantTextRegex.atomic.test(checkText)) {
        log('debug', 'Page content indicates active Atomic game');
        return 'atomic';
      }
      if (variantTextRegex.horde.test(checkText)) {
        log('debug', 'Page content indicates active Horde game');
        return 'horde';
      }
      if (variantTextRegex.racingKings.test(checkText)) {
        log('debug', 'Page content indicates active Racing Kings game');
        return 'racingKings';
      }
      
      // Method 3: Check for variant-specific UI elements
      log('debug', 'Checking UI elements for variant indicators');
      
      if (document.querySelector('.variant-crazyhouse, .variant-zh')) {
        log('debug', 'UI elements indicate Crazyhouse');
        return 'crazyhouse';
      }
      if (document.querySelector('.variant-chess960, .variant-960')) {
        log('debug', 'UI elements indicate Chess960');
        return 'chess960';
      }
      if (document.querySelector('.variant-kingofthehill, .variant-koth')) {
        log('debug', 'UI elements indicate King of the Hill');
        return 'kingOfTheHill';
      }
      if (document.querySelector('.variant-threecheck, .variant-3check')) {
        log('debug', 'UI elements indicate Three-check');
        return 'threeCheck';
      }
      if (document.querySelector('.variant-antichess')) {
        log('debug', 'UI elements indicate Antichess');
        return 'antichess';
      }
      if (document.querySelector('.variant-atomic')) {
        log('debug', 'UI elements indicate Atomic');
        return 'atomic';
      }
      if (document.querySelector('.variant-horde')) {
        log('debug', 'UI elements indicate Horde');
        return 'horde';
      }
      if (document.querySelector('.variant-racingkings')) {
        log('debug', 'UI elements indicate Racing Kings');
        return 'racingKings';
      }
      
      // Method 4: Check if this is a standard chess position using move list backtracking
      log('debug', 'Checking for standard chess position using move list backtracking');
      if (isStandardChessFromMoveList()) {
        log('debug', 'Determined standard chess based on move list backtracking');
        return 'standard';
      }
      
      // Method 5: Check for Chess960 (lowest priority, most error-prone method)
      log('debug', 'Checking for Chess960 board setup (last resort method)');
      if (detectChess960BoardSetup()) {
        log('debug', 'Chess960 detected based on non-standard board setup');
        return 'chess960';
      }
      
      // Default to standard
      log('debug', 'No specific variant detected, defaulting to standard chess');
      return 'standard';
    } catch (e) {
      log('error', 'Error detecting chess variant:', e);
      return currentVariant; // Keep current if error
    }
  }

  // Function to determine if this is standard chess based on move list backtracking
  function isStandardChessFromMoveList() {
    try {
      // Get the current move list
      const moveData = extractMoveList();
      const moveList = moveData.moveList;
      
      log('debug', `Checking move list (${moveList.length} moves): ${moveList.join(', ')}`);
      
      // If there are no moves, use the current board state
      if (!moveList.length) {
        log('debug', 'No moves made, checking current board state');
        const pieces = extractPieces();
        return isStandardChessPosition(pieces);
      }
      
      // Look for key indicators in early moves that would only be possible in standard chess
      // In standard chess, the first few moves typically involve pawns, knights, or specific piece movements
      const earlyMoves = moveList.slice(0, Math.min(6, moveList.length));
      log('debug', 'Examining early moves:', earlyMoves);
      
      // Create a regex to match standard opening moves
      // Standard pawn moves: e4, d4, c4, Nf3, etc.
      const standardOpeningRegex = /^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8]|O-O|O-O-O)(\+|#)?$/;
      
      // Check if the first few moves follow standard chess patterns
      let standardMovePatterns = true;
      for (const move of earlyMoves) {
        if (!standardOpeningRegex.test(move)) {
          standardMovePatterns = false;
          log('debug', `Move "${move}" does not match standard chess pattern`);
          break;
        }
      }
      
      if (standardMovePatterns) {
        log('debug', 'Early moves follow standard chess patterns');
        return true;
      }
      
      // If we have a raw move text, check it for indicators of standard chess
      if (moveData.rawMoveText) {
        // Standard chess notation often has move numbers like "1.e4 e5 2.Nf3"
        const standardNotationRegex = /\d+\.\s*([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8]|O-O|O-O-O)/;
        if (standardNotationRegex.test(moveData.rawMoveText)) {
          log('debug', 'Move text contains standard chess notation with move numbers');
          return true;
        }
      }
      
      // Check the current board state as a fallback
      log('debug', 'Checking current board state as fallback');
      const pieces = extractPieces();
      return isStandardChessPosition(pieces);
      
    } catch (e) {
      log('error', 'Error in isStandardChessFromMoveList:', e);
      return false;
    }
  }

  function detectChess960BoardSetup() {
    // Only run this check on games that appear to be at the beginning
    // to avoid false positives during mid-game
    const moveData = extractMoveList();
    if (moveData.moveList.length > 4) {
      // If more than 4 moves have been made, don't use this detection method
      return false;
    }
    
    const pieces = extractPieces();
    
    // FIRST: Check if this is a standard chess position - if it is, return false immediately
    if (isStandardChessPosition(pieces)) {
      log('debug', 'Position appears to be standard chess setup');
      return false;
    }
    
    // In standard chess, the back rank follows a specific pattern
    const standardWhiteBackRank = {
      'a1': 'wR', 'b1': 'wN', 'c1': 'wB', 'd1': 'wQ', 'e1': 'wK', 'f1': 'wB', 'g1': 'wN', 'h1': 'wR'
    };
    
    const standardBlackBackRank = {
      'a8': 'bR', 'b8': 'bN', 'c8': 'bB', 'd8': 'bQ', 'e8': 'bK', 'f8': 'bB', 'g8': 'bN', 'h8': 'bR'
    };
    
    // Count non-standard positions
    let nonStandardPositionsCount = 0;
    let totalPiecesChecked = 0;
    
    // Check white back rank (focusing on bishops, knights, and queens)
    for (let file of 'abcdefgh') {
      const whiteSquare = `${file}1`;
      const blackSquare = `${file}8`;
      
      // Only count pieces that should be fixed in standard chess
      // Ignore rooks and kings which might have moved due to castling
      if (pieces[whiteSquare] && standardWhiteBackRank[whiteSquare] &&
          !['wR', 'wK', 'bR', 'bK'].includes(standardWhiteBackRank[whiteSquare])) {
        totalPiecesChecked++;
        if (pieces[whiteSquare] !== standardWhiteBackRank[whiteSquare]) {
          nonStandardPositionsCount++;
        }
      }
      
      if (pieces[blackSquare] && standardBlackBackRank[blackSquare] &&
          !['wR', 'wK', 'bR', 'bK'].includes(standardBlackBackRank[blackSquare])) {
        totalPiecesChecked++;
        if (pieces[blackSquare] !== standardBlackBackRank[blackSquare]) {
          nonStandardPositionsCount++;
        }
      }
    }
    
    // Only consider it Chess960 if:
    // 1. We've checked at least 4 pieces (to avoid sparse data issues)
    // 2. At least 3 pieces are in non-standard positions (more strict)
    // 3. At least 50% of checked pieces are in non-standard positions
    return (totalPiecesChecked >= 4 && 
            nonStandardPositionsCount >= 3 && 
            (nonStandardPositionsCount / totalPiecesChecked) >= 0.5);
  }

  // Helper function to check for standard chess starting position
  function isStandardChessPosition(pieces) {
    // Dump full piece positions for debugging
    log('debug', 'Current pieces on board:', JSON.stringify(pieces));
    
    // Define the standard chess starting position for key pieces
    const standardPositions = {
      // White back rank core pieces
      'b1': 'wN', 'c1': 'wB', 'd1': 'wQ', 'e1': 'wK', 'f1': 'wB', 'g1': 'wN',
      // Black back rank core pieces
      'b8': 'bN', 'c8': 'bB', 'd8': 'bQ', 'e8': 'bK', 'f8': 'bB', 'g8': 'bN',
      // Pawns from both sides (check a subset)
      'b2': 'wP', 'd2': 'wP', 'f2': 'wP', 'h2': 'wP',
      'a7': 'bP', 'c7': 'bP', 'e7': 'bP', 'g7': 'bP'
    };
    
    // Count how many standard positions are matched
    let matchCount = 0;
    let totalPositions = 0;
    let matchDetails = [];
    
    for (const [square, expectedPiece] of Object.entries(standardPositions)) {
      totalPositions++;
      
      // Record match or mismatch for debugging
      const actualPiece = pieces[square];
      const isMatch = actualPiece === expectedPiece;
      matchDetails.push(`${square}: expected=${expectedPiece}, actual=${actualPiece || 'empty'}, match=${isMatch}`);
      
      if (isMatch) {
        matchCount++;
      }
    }
    
    // Log detailed matching information
    log('debug', 'Standard position matching details:\n' + matchDetails.join('\n'));
    
    // Use a general approach: Check for main characteristics of a standard chess game
    // 1. Count white pawns on rank 2
    // 2. Count black pawns on rank 7
    let whitePawnsOnRank2 = 0;
    let blackPawnsOnRank7 = 0;
    
    for (let file of 'abcdefgh') {
      if (pieces[`${file}2`] === 'wP') whitePawnsOnRank2++;
      if (pieces[`${file}7`] === 'bP') blackPawnsOnRank7++;
    }
    
    log('debug', `Pawn distribution - white pawns on rank 2: ${whitePawnsOnRank2}, black pawns on rank 7: ${blackPawnsOnRank7}`);
    
    // Check for the kings in standard positions - critically important
    const hasStandardKingPositions = pieces['e1'] === 'wK' && pieces['e8'] === 'bK';
    
    // Check for rooks in standard positions
    const hasStandardRookPositions = 
      (pieces['a1'] === 'wR' || !pieces['a1']) && 
      (pieces['h1'] === 'wR' || !pieces['h1']) && 
      (pieces['a8'] === 'bR' || !pieces['a8']) && 
      (pieces['h8'] === 'bR' || !pieces['h8']);
    
    // If at least 70% of key positions match, consider it a standard position
    const matchRatio = matchCount / totalPositions;
    log('debug', `Standard position detection: ${matchCount}/${totalPositions} matches (${matchRatio.toFixed(2)})`);
    
    // Multiple detection criteria:
    // 1. Main detection: at least 70% of key positions match
    const keyPositionsMatch = matchRatio >= 0.7;
    
    // 2. Pawn-based detection: at least 6 pawns in standard positions
    const pawnPositionsMatch = (whitePawnsOnRank2 + blackPawnsOnRank7) >= 6;
    
    // 3. Kings and rooks in standard positions (or empty rook squares which could mean castled/captured)
    const kingAndRookPositionsMatch = hasStandardKingPositions && hasStandardRookPositions;
    
    // Return true if ANY of these conditions are met
    const isStandard = keyPositionsMatch || pawnPositionsMatch || kingAndRookPositionsMatch;
    log('debug', `Final standard position detection result: ${isStandard} (keys: ${keyPositionsMatch}, pawns: ${pawnPositionsMatch}, kings+rooks: ${kingAndRookPositionsMatch})`);
    
    return isStandard;
  }

  function showVariantSuggestion(suggestedVariant) {
    log('info', `Detected variant (${suggestedVariant}) differs from manual setting (${currentVariant})`);
    
    // Update suggestion UI
    const suggestionBtn = document.getElementById('ec-variant-suggestion');
    if (suggestionBtn) {
      suggestionBtn.textContent = `Switch to ${suggestedVariant}`;
      suggestionBtn.dataset.variant = suggestedVariant;
      suggestionBtn.style.display = 'block';
    }
  }

  function acceptVariantSuggestion() {
    const suggestionBtn = document.getElementById('ec-variant-suggestion');
    if (suggestionBtn && suggestionBtn.dataset.variant) {
      const suggestedVariant = suggestionBtn.dataset.variant;
      setVariant(suggestedVariant, false);
      manualVariantMode = false;
      GM_setValue('manualVariantMode', false);
      variantDetectionLocked = false;
      
      // Hide suggestion
      suggestionBtn.style.display = 'none';
      
      log('info', `Accepted variant suggestion: ${suggestedVariant}`);
      onBoardChange(); // Force update
    }
  }

  // --- Enhanced Board & Move Extraction ---
  
  function detectBoardOrientation() {
    // Default: white on bottom (from player's perspective)
    let orientation = 'white';
    
    try {
      // Method 1: Check for flipped class on board container
      const board = document.querySelector('wc-chess-board, .board');
      if (board && (board.classList.contains('flipped') || board.getAttribute('class').includes('flipped'))) {
        orientation = 'black';
      }
      
      // Method 2: Check piece positions - in normal orientation, white pieces are on ranks 1-2
      const pieces = extractPieces();
      let whiteOnTop = false;
      let whiteOnBottom = false;
      
      for (const [square, piece] of Object.entries(pieces)) {
        if (piece && piece.startsWith('w')) {
          const rank = parseInt(square[1]);
          if (rank <= 2) whiteOnBottom = true;
          if (rank >= 7) whiteOnTop = true;
        }
      }
      
      // If white pieces are predominantly on top, board is flipped
      if (whiteOnTop && !whiteOnBottom) {
        orientation = 'black';
      }
    } catch (e) {
      log('error', 'Error detecting board orientation:', e);
    }
    
    return orientation;
  }

  function extractPieces() {
    const type = detectBoardType();
    let pieces = {};
    
    if (type === 'WC_BOARD') {
      const wcBoard = document.querySelector('wc-chess-board');
      if (wcBoard) {
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
      }
    } else if (type === 'LIVE_BOARD') {
      const liveBoard = document.querySelector('.TheBoard-layers');
      if (liveBoard) {
        // Extract pieces using pixel mapping
        const pieceElements = document.querySelectorAll('.TheBoard-pieces .piece[data-piece][style*="translate"]');
        log('debug', `Found ${pieceElements.length} piece elements in LIVE_BOARD.`);
        
        // Get board dimensions
        const boardRect = liveBoard.getBoundingClientRect();
        const boardSize = Math.min(boardRect.width, boardRect.height);
        const squareSize = boardSize / 8;
        
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
            
            if (fileIdx >= 0 && fileIdx < 8 && rankIdx >= 0 && rankIdx < 8) {
              const file = String.fromCharCode('a'.charCodeAt(0) + fileIdx);
              const rank = 8 - rankIdx;
              
              // Convert Chess.com piece codes to our format
              // Chess.com uses: 'wp' for white pawn, etc.
              const color = piece[0] === 'w' ? 'w' : 'b';
              const type = piece[1].toUpperCase();
              pieces[`${file}${rank}`] = color + type;
            }
          }
        });
      }
    }
    
    return pieces;
  }

  function extractMoveList() {
    const type = detectBoardType();
    let moveList = [];
    let rawMoveText = "";
    
    if (type === 'WC_BOARD') {
      // Extract move list as SAN from wc-simple-move-list
      const moveListContainer = document.querySelector('wc-simple-move-list');
      if (moveListContainer) {
        rawMoveText = moveListContainer.textContent.trim();
        const moveNodes = moveListContainer.querySelectorAll('.node .node-highlight-content');
        log('debug', `Found ${moveNodes.length} move nodes in wc-simple-move-list.`);
        
        moveNodes.forEach(el => {
          const san = el.textContent.trim();
          if (san) moveList.push(san);
        });
      }
    } else if (type === 'LIVE_BOARD') {
      // Extract move list from move list container
      const moveListContainer = document.querySelector('.moves-moves-list, .move-list-wrapper');
      if (moveListContainer) {
        rawMoveText = moveListContainer.textContent.trim();
        const moveNodes = moveListContainer.querySelectorAll('.moves-table-cell.moves-move, .move-text');
        log('debug', `Found ${moveNodes.length} move nodes in LIVE_BOARD.`);
        
        moveNodes.forEach(el => {
          const san = el.textContent.trim();
          if (san) moveList.push(san);
        });
      }
    }
    
    return { moveList, rawMoveText };
  }

  function extractBoardData() {
    const type = detectBoardType();
    log('debug', 'Extracting board data. Type:', type);
    
    // Initialize data
    let pieces = {};
    let moveList = [];
    let rawMoveText = "";
    
    // Extract data based on board type
    if (type === 'WC_BOARD' || type === 'LIVE_BOARD') {
      pieces = extractPieces();
      const moveData = extractMoveList();
      moveList = moveData.moveList;
      rawMoveText = moveData.rawMoveText;
    } else {
      log('warn', 'Unknown board type, cannot extract data');
      return null;
    }
    
    // Detect board orientation
    const boardOrientation = detectBoardOrientation();
    
    // Detect variant
    const detectedVariant = detectChessVariant();
    if (detectedVariant !== currentVariant && !manualVariantMode) {
      log('info', `Updating variant from ${currentVariant} to detected ${detectedVariant}`);
      setVariant(detectedVariant);
    }
    
    // Check if this is a new game
    if (detectNewGame(pieces, moveList)) {
      startNewGame(pieces, moveList, currentVariant);
    } else {
      // Update existing game
      updateCurrentGame(pieces, moveList);
    }
    
    // Create the board layout structure
    const boardLayout = createBoardLayout(pieces);
    
    // Prepare the complete data object
    const data = {
      gameId: currentGame.id,
      pieces: pieces,
      moveList: moveList,
      rawMoveText: rawMoveText,
      variant: currentVariant,
      flags: {
        possibleCastling: detectPossibleCastling(pieces, moveList),
        possibleEnPassant: detectPossibleEnPassant(moveList),
        boardFlipped: boardOrientation === 'black'
      },
      boardOrientation: boardOrientation,
      boardLayout: boardLayout,
      timestamp: Date.now()
    };
    
    log('debug', 'Extracted board data:', data);
    return data;
  }

  function createBoardLayout(pieces) {
    const files = 8;
    const ranks = 8;
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
    
    return { files, ranks, squares };
  }

  function detectPossibleCastling(pieces, moveList) {
    // Check if kings and rooks are in their original positions
    const hasWhiteKingOnE1 = pieces['e1'] === 'wK';
    const hasBlackKingOnE8 = pieces['e8'] === 'bK';
    const hasWhiteRookOnA1 = pieces['a1'] === 'wR';
    const hasWhiteRookOnH1 = pieces['h1'] === 'wR';
    const hasBlackRookOnA8 = pieces['a8'] === 'bR';
    const hasBlackRookOnH8 = pieces['h8'] === 'bR';
    
    return hasWhiteKingOnE1 || hasBlackKingOnE8 || 
           hasWhiteRookOnA1 || hasWhiteRookOnH1 || 
           hasBlackRookOnA8 || hasBlackRookOnH8;
  }

  function detectPossibleEnPassant(moveList) {
    // If there are moves, check if the last move could enable en passant
    if (moveList.length > 0) {
      const lastMove = moveList[moveList.length - 1];
      // Pawn moved two squares (usually contains 'a2a4' style notation)
      return /^[a-h][27][a-h][45]$/.test(lastMove.replace(/\W/g, ''));
    }
    return false;
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

  function onBoardChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const data = extractBoardData();
      if (!data) return;
      
      // Only send if changed
      const isMoveListChanged = JSON.stringify(data.moveList) !== JSON.stringify(lastSent.moveList);
      const isPiecesChanged = JSON.stringify(data.pieces) !== JSON.stringify(lastSent.pieces);
      const isVariantChanged = data.variant !== lastSent.variant;
      
      if (isPiecesChanged || isMoveListChanged || isVariantChanged) {
        sendBoardData(data);
        lastSent = { 
          pieces: JSON.parse(JSON.stringify(data.pieces)), 
          moveList: JSON.parse(JSON.stringify(data.moveList)), 
          variant: data.variant 
        };
      }
    }, DEBOUNCE_MS);
  }

  function setupObserver() {
    const boardArea = document.querySelector('wc-chess-board') || document.querySelector('.TheBoard-layers');
    if (!boardArea) {
      log('warn', 'No board element found to observe');
      return;
    }
    
    log('debug', 'Setting up mutation observer on board');
    const observer = new MutationObserver(onBoardChange);
    observer.observe(boardArea, { childList: true, subtree: true, attributes: true });
    
    // Also observe move list containers
    const moveListContainer = document.querySelector('wc-simple-move-list') || 
                              document.querySelector('.moves-moves-list, .move-list-wrapper');
    if (moveListContainer) {
      log('debug', 'Setting up mutation observer on move list');
      const moveObserver = new MutationObserver(onBoardChange);
      moveObserver.observe(moveListContainer, { childList: true, subtree: true });
    }
  }

  // --- Backend Communication ---
  function sendBoardData(data) {
    log('debug', 'Sending board data to backend');
    
    // Use WebSocket if connected
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'board_update',
        data: data
      }));
      log('debug', 'Sent board data via WebSocket');
      return;
    }
    
    // Use HTTP fallback
    GM_xmlhttpRequest({
      method: 'POST',
      url: BACKEND_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data),
      onload: function(response) {
        log('info', 'POST Success:', response.status);
        log('debug', 'Response:', response.responseText);
      },
      onerror: function(response) {
        log('error', 'POST Error:', response.status, response.statusText);
      }
    });
  }

  // --- WebSocket for Bidirectional Communication ---
  function connectWebSocket() {
    if (ws) {
      ws.onclose = null; // Prevent auto-reconnect from old connection
      ws.close();
    }
    
    log('info', 'Connecting to WebSocket:', WS_URL);
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      log('info', 'WebSocket connected');
      updateConnectionStatus(true);
      
      // Send current game state if we have one
      if (currentGame.id) {
        log('debug', 'Sending current game state on WebSocket connection');
        sendNewGameNotification();
        onBoardChange(); // Force a board update
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        log('debug', 'WS message received:', message);
        
        // Handle different message types
        if (message.type === 'highlight_square') {
          highlightSquare(message.square, message.color);
        } else if (message.type === 'clear_highlights') {
          clearHighlights();
        } else if (message.type === 'show_arrow') {
          showArrow(message.fromSquare, message.toSquare, message.color);
        } else if (message.type === 'set_engine_eval') {
          updateEngineEval(message.eval, message.depth, message.pv);
        } else if (message.type === 'ping') {
          // Respond to ping with pong
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (e) {
        log('error', 'Error processing WebSocket message:', e);
      }
    };
    
    ws.onclose = () => {
      log('warn', 'WebSocket disconnected');
      updateConnectionStatus(false);
      setTimeout(connectWebSocket, 5000); // Try to reconnect every 5 seconds
    };
    
    ws.onerror = (e) => {
      log('error', 'WebSocket error:', e);
      updateConnectionStatus(false);
    };
  }
  
  function forceReconnect() {
    log('info', 'Forcing WebSocket reconnection');
    connectWebSocket();
  }
  
  // Placeholder functions for overlay features (to be implemented in future phases)
  function highlightSquare(square, color) {
    log('debug', `Highlighting square ${square} with color ${color}`);
    // TODO: Implement highlighting
  }
  
  function clearHighlights() {
    log('debug', 'Clearing all highlights');
    // TODO: Implement clearing highlights
  }
  
  function showArrow(fromSquare, toSquare, color) {
    log('debug', `Showing arrow from ${fromSquare} to ${toSquare} with color ${color}`);
    // TODO: Implement arrows
  }
  
  function updateEngineEval(evaluation, depth, pv) {
    log('debug', `Updating engine eval: ${evaluation} at depth ${depth}`);
    // TODO: Implement engine evaluation display
  }

  // --- UI Controls ---
  function createUI() {
    // Remove any existing UI
    removeExistingUI();
    
    // Create main container
    const container = document.createElement('div');
    container.id = 'en-croissant-controls';
    container.className = 'ec-ui-component';
    container.style.position = 'fixed';
    container.style.bottom = '10px';
    container.style.right = '10px';
    container.style.background = '#222';
    container.style.color = '#fff';
    container.style.padding = '10px';
    container.style.borderRadius = '5px';
    container.style.zIndex = '9999';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '8px';
    container.style.boxShadow = '0 3px 10px rgba(0,0,0,0.3)';
    container.style.minWidth = '200px';
    container.style.transition = 'all 0.3s ease';
    container.style.fontFamily = 'Arial, sans-serif';
    
    // If UI is hidden, collapse it
    if (!uiVisible) {
      container.style.height = '30px';
      container.style.overflow = 'hidden';
    }
    
    // Add title and toggle button
    const titleBar = document.createElement('div');
    titleBar.style.display = 'flex';
    titleBar.style.justifyContent = 'space-between';
    titleBar.style.alignItems = 'center';
    titleBar.style.borderBottom = '1px solid #444';
    titleBar.style.paddingBottom = '5px';
    titleBar.style.marginBottom = '5px';
    titleBar.style.cursor = 'pointer';
    
    // Make title bar toggle the UI when clicked
    titleBar.addEventListener('click', toggleUIVisibility);
    
    const title = document.createElement('div');
    title.textContent = 'En Croissant Sync';
    title.style.fontWeight = 'bold';
    title.style.pointerEvents = 'none';
    
    titleBar.appendChild(title);
    container.appendChild(titleBar);
    
    // Add variant selector
    const variantSelector = createVariantSelector();
    container.appendChild(variantSelector);
    
    // Add variant suggestion button (hidden by default)
    const suggestionBtn = document.createElement('button');
    suggestionBtn.id = 'ec-variant-suggestion';
    suggestionBtn.style.display = 'none';
    suggestionBtn.style.padding = '5px 10px';
    suggestionBtn.style.background = '#3a813a';
    suggestionBtn.style.border = 'none';
    suggestionBtn.style.borderRadius = '3px';
    suggestionBtn.style.color = '#fff';
    suggestionBtn.style.cursor = 'pointer';
    suggestionBtn.style.marginTop = '5px';
    suggestionBtn.style.fontSize = '12px';
    suggestionBtn.addEventListener('click', acceptVariantSuggestion);
    container.appendChild(suggestionBtn);
    
    // Add buttons container
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.display = 'flex';
    buttonsContainer.style.flexDirection = 'column';
    buttonsContainer.style.gap = '5px';
    
    // Add "New Game" button
    const newGameBtn = document.createElement('button');
    newGameBtn.textContent = 'New Game';
    newGameBtn.className = 'ec-button';
    newGameBtn.style.padding = '5px 10px';
    newGameBtn.style.background = '#444';
    newGameBtn.style.border = 'none';
    newGameBtn.style.borderRadius = '3px';
    newGameBtn.style.color = '#fff';
    newGameBtn.style.cursor = 'pointer';
    newGameBtn.addEventListener('click', () => {
      const pieces = extractPieces();
      const moveData = extractMoveList();
      startNewGame(pieces, moveData.moveList, currentVariant);
      onBoardChange(); // Force update
    });
    buttonsContainer.appendChild(newGameBtn);
    
    // Add "Force Sync" button
    const forceSyncBtn = document.createElement('button');
    forceSyncBtn.textContent = 'Force Sync';
    forceSyncBtn.className = 'ec-button';
    forceSyncBtn.style.padding = '5px 10px';
    forceSyncBtn.style.background = '#444';
    forceSyncBtn.style.border = 'none';
    forceSyncBtn.style.borderRadius = '3px';
    forceSyncBtn.style.color = '#fff';
    forceSyncBtn.style.cursor = 'pointer';
    forceSyncBtn.addEventListener('click', () => {
      onBoardChange(); // Force update immediate board data
    });
    buttonsContainer.appendChild(forceSyncBtn);
    
    // Add "Reconnect" button
    const reconnectBtn = document.createElement('button');
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.className = 'ec-button';
    reconnectBtn.style.padding = '5px 10px';
    reconnectBtn.style.background = '#444';
    reconnectBtn.style.border = 'none';
    reconnectBtn.style.borderRadius = '3px';
    reconnectBtn.style.color = '#fff';
    reconnectBtn.style.cursor = 'pointer';
    reconnectBtn.addEventListener('click', forceReconnect);
    buttonsContainer.appendChild(reconnectBtn);
    
    container.appendChild(buttonsContainer);
    
    // Add connection status indicator
    const statusIndicator = document.createElement('div');
    statusIndicator.id = 'ec-connection-status';
    statusIndicator.textContent = 'Disconnected';
    statusIndicator.style.fontSize = '12px';
    statusIndicator.style.color = '#ff5555';
    statusIndicator.style.marginTop = '5px';
    statusIndicator.style.textAlign = 'center';
    container.appendChild(statusIndicator);
    
    // Add to page
    document.body.appendChild(container);
    
    // Also create log level button
    createLogLevelButton();
    
    // Update UI components
    updateVariantSelector();
    updateConnectionStatus(false);
    
    log('info', 'UI created');
    return container;
  }
  
  function removeExistingUI() {
    // Remove any existing UI elements
    const existingUI = document.querySelectorAll('.ec-ui-component');
    existingUI.forEach(el => el.remove());
    
    const logBtn = document.getElementById('ec-log-level-btn');
    if (logBtn) logBtn.remove();
  }
  
  function toggleUIVisibility() {
    const container = document.getElementById('en-croissant-controls');
    if (!container) return;
    
    uiVisible = !uiVisible;
    GM_setValue('uiVisible', uiVisible);
    
    if (uiVisible) {
      container.style.height = 'auto';
    } else {
      container.style.height = '30px';
    }
    
    log('debug', `UI visibility toggled: ${uiVisible ? 'visible' : 'hidden'}`);
  }
  
  function createVariantSelector() {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '5px';
    
    const label = document.createElement('label');
    label.textContent = 'Variant:';
    label.style.fontSize = '12px';
    
    const select = document.createElement('select');
    select.id = 'ec-variant-select';
    select.style.background = '#333';
    select.style.color = '#fff';
    select.style.border = '1px solid #555';
    select.style.borderRadius = '3px';
    select.style.padding = '2px 5px';
    select.style.flexGrow = '1';
    
    // Add variant options
    SUPPORTED_VARIANTS.forEach(variant => {
      const option = document.createElement('option');
      option.value = variant.value;
      option.textContent = variant.label;
      select.appendChild(option);
    });
    
    // Add manual toggle checkbox
    const manualToggle = document.createElement('input');
    manualToggle.type = 'checkbox';
    manualToggle.id = 'ec-manual-variant';
    manualToggle.checked = manualVariantMode;
    manualToggle.style.marginLeft = '5px';
    
    const manualLabel = document.createElement('label');
    manualLabel.htmlFor = 'ec-manual-variant';
    manualLabel.textContent = 'Manual';
    manualLabel.style.fontSize = '10px';
    manualLabel.style.marginLeft = '2px';
    
    select.addEventListener('change', (e) => {
      setVariant(e.target.value, manualToggle.checked);
    });
    
    manualToggle.addEventListener('change', (e) => {
      manualVariantMode = e.target.checked;
      GM_setValue('manualVariantMode', manualVariantMode);
      
      if (manualVariantMode) {
        // If switching to manual, lock in the current variant
        setVariant(select.value, true);
      } else {
        // If switching to auto, try to detect the variant
        variantDetectionLocked = false;
        const detectedVariant = detectChessVariant();
        if (detectedVariant !== currentVariant) {
          setVariant(detectedVariant, false);
        }
      }
      
      log('info', `Manual variant mode ${manualVariantMode ? 'enabled' : 'disabled'}`);
    });
    
    wrapper.appendChild(label);
    wrapper.appendChild(select);
    wrapper.appendChild(manualToggle);
    wrapper.appendChild(manualLabel);
    
    return wrapper;
  }
  
  function updateVariantSelector() {
    const select = document.getElementById('ec-variant-select');
    const manualToggle = document.getElementById('ec-manual-variant');
    
    if (select) select.value = currentVariant;
    if (manualToggle) manualToggle.checked = manualVariantMode;
  }
  
  function updateConnectionStatus(connected) {
    const statusIndicator = document.getElementById('ec-connection-status');
    if (!statusIndicator) return;
    
    if (connected) {
      statusIndicator.textContent = 'Connected';
      statusIndicator.style.color = '#55ff55';
    } else {
      statusIndicator.textContent = 'Disconnected';
      statusIndicator.style.color = '#ff5555';
    }
  }

  // --- CSS Styles ---
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .ec-ui-component {
        font-family: Arial, sans-serif;
        font-size: 13px;
      }
      
      .ec-button {
        transition: background-color 0.2s ease;
      }
      
      .ec-button:hover {
        background-color: #555 !important;
      }
      
      #ec-variant-suggestion:hover {
        background-color: #4a914a !important;
      }
      
      #ec-log-level-btn:hover {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  // --- Main Init ---
  function mainInit() {
    log('info', 'Initializing En Croissant Chess.com integration v1.2');
    injectStyles();
    observeBodyForBoard();
    tryInitBoardSync(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mainInit);
  } else {
    mainInit();
  }

})();
