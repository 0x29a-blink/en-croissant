import { listen, type Event } from "@tauri-apps/api/event";
import { useContext, useEffect } from "react";
import { useStore } from "zustand";
import { TreeStateContext } from "./common/TreeStateContext";
import { useAtomValue, useSetAtom } from "jotai";
import { activeVariantAtom, fenSyncEnabledAtom } from "@/state/atoms";
import { getDefaultStore } from "jotai";

/**
 * Enhanced data structure for board state updates from backend
 */
interface BoardStateUpdate {
  fen: string;
  variant: string;
  game_id: string;
}

/**
 * New game notification structure from backend
 */
interface NewGameNotification {
  type: string;
  game_id: string;
  variant: string;
  start_position: Record<string, string>;
  timestamp: number;
}

/**
 * Listens for FEN updates and board state updates pushed from the Tauri backend
 * (originating from the Chess.com userscript) and updates the main tree state,
 * if the fenSyncEnabled setting is active.
 * 
 * Now handles variant information and supports game state management.
 */
function FenListener() {
  const store = useContext(TreeStateContext);
  
  // 1. If store context is not available, render nothing.
  if (!store) {
    // We can log here, but it might be noisy as it waits for context.
    // console.log("[FEN Sync] Store context not available yet, skipping listener setup.");
    return null;
  }

  // 2. Store is available, call hooks at the top level.
  const isFenSyncEnabled = useAtomValue(fenSyncEnabledAtom);
  const setActiveVariant = useSetAtom(activeVariantAtom);
  const setFen = useStore(store, (s) => s.setFen);

  useEffect(() => {
    // Store is guaranteed to be non-null here because of the check above.
    // setFen is also guaranteed to be available.

    // Only proceed if FEN sync is enabled in settings
    if (!isFenSyncEnabled) {
      console.log("[FEN Sync] FEN Sync is disabled in settings.");
      // Cleanup function below will handle detaching listener if setting is toggled off.
      return; // Don't setup listener if disabled from the start
    }
    
    // We already got setFen from the top-level useStore call.
    // if (!setFen) { ... } // This check is likely redundant now.

    let unlistenFen: (() => void) | undefined;
    let unlistenBoardState: (() => void) | undefined;
    let unlistenNewGame: (() => void) | undefined;

    const setupListeners = async () => {
      console.log("[FEN Sync] Setting up event listeners...");
      
      try {
        // Basic FEN listener (backward compatibility)
        unlistenFen = await listen<string>("fen-update", (event: Event<string>) => {
          // Check setting before applying the update
          const currentlyEnabled = getDefaultStore().get(fenSyncEnabledAtom);
          
          if (currentlyEnabled) {
            // Directly use the payload if it's a non-empty string
            const fenString = typeof event.payload === 'string' && event.payload.trim() !== '' 
              ? event.payload.trim() 
              : undefined;

            if (fenString) {
              console.log("[FEN Sync] Received FEN update:", fenString);
              setFen(fenString);
            } else {
              console.warn("[FEN Sync] Ignored FEN update: payload is not a valid FEN string.", event.payload);
            }
          } else {
            console.log("[FEN Sync] Ignored FEN update (sync disabled).");
          }
        });
        console.log("[FEN Sync] Listening for basic FEN updates.");

        // Enhanced board state listener
        unlistenBoardState = await listen<BoardStateUpdate>("board-state-update", (event: Event<BoardStateUpdate>) => {
          const currentlyEnabled = getDefaultStore().get(fenSyncEnabledAtom);
          
          if (currentlyEnabled && event.payload) {
            const { fen, variant, game_id } = event.payload;
            
            console.log(`[FEN Sync] Received board state for game ${game_id}, variant: ${variant}`);
            
            // Update variant in state
            if (variant) {
              setActiveVariant(variant);
            }
            
            // Update FEN in tree state
            if (fen && fen.trim() !== '') {
              console.log("[FEN Sync] Updating FEN:", fen);
              setFen(fen);
            }
          } else {
            console.log("[FEN Sync] Ignored board state update (sync disabled or invalid payload).");
          }
        });
        console.log("[FEN Sync] Listening for enhanced board state updates.");
        
        // New game notification listener
        unlistenNewGame = await listen<NewGameNotification>("new-game", (event: Event<NewGameNotification>) => {
          const currentlyEnabled = getDefaultStore().get(fenSyncEnabledAtom);
          
          if (currentlyEnabled && event.payload) {
            const { game_id, variant } = event.payload;
            
            console.log(`[FEN Sync] New game detected: ${game_id}, variant: ${variant}`);
            
            // Update variant in state
            if (variant) {
              setActiveVariant(variant);
            }
            
            // Don't update FEN here - we'll wait for the board-state-update that follows
          }
        });
        console.log("[FEN Sync] Listening for new game notifications.");
        
      } catch (error) {
        console.error("[FEN Sync] Failed to set up Tauri event listeners:", error);
      }
    };

    setupListeners();

    // Cleanup function: always runs when effect dependencies change or component unmounts
    return () => {
      if (unlistenFen) {
        unlistenFen();
      }
      if (unlistenBoardState) {
        unlistenBoardState();
      }
      if (unlistenNewGame) {
        unlistenNewGame();
      }
      console.log("[FEN Sync] Stopped listening for updates.");
    };
    // Re-run effect if store (identity changes) or the enabled setting changes
  }, [store, isFenSyncEnabled, setFen, setActiveVariant]); // Added setFen and setActiveVariant dependencies

  // This component doesn't render anything itself
  return null;
}

export default FenListener; 