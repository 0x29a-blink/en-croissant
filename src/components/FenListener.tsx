import { listen, type Event } from "@tauri-apps/api/event";
import { useContext, useEffect } from "react";
import { useStore } from "zustand";
import { TreeStateContext } from "./common/TreeStateContext";
import { useAtomValue } from "jotai";
import { fenSyncEnabledAtom } from "@/state/atoms";
import { getDefaultStore } from "jotai";

/**
 * Listens for FEN updates pushed from the Tauri backend
 * (originating from the ViolentMonkey script) and updates the main tree state,
 * if the fenSyncEnabled setting is active.
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

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      console.log("[FEN Sync] Attempting to set up listener...");
      try {
        unlisten = await listen<string>("fen-update", (event: Event<string>) => {
          // Check setting *again* before applying the update
          // Read the latest value directly from the Jotai default store
          const currentlyEnabled = getDefaultStore().get(fenSyncEnabledAtom);

          if (currentlyEnabled) {
            console.log("[FEN Sync] Received FEN update event:", event.payload);
            // Accept payload as either object with "fen" property or JSON string
            let fenString: string | undefined = undefined;
            if (
              typeof event.payload === "object" &&
              event.payload !== null &&
              Object.prototype.hasOwnProperty.call(event.payload, "fen")
            ) {
              fenString = (event.payload as { fen: string }).fen;
            } else if (typeof event.payload === "string") {
              try {
                const parsed = JSON.parse(event.payload);
                if (
                  typeof parsed === "object" &&
                  parsed !== null &&
                  Object.prototype.hasOwnProperty.call(parsed, "fen")
                ) {
                  fenString = (parsed as { fen: string }).fen;
                }
              } catch (e) {
                // Not a JSON string, ignore
              }
            }
            if (fenString) {
              setFen(fenString);
            } else {
              console.warn("[FEN Sync] Ignored FEN update: payload is not an object with a 'fen' property or valid JSON string.", event.payload);
            }
          } else {
            console.log("[FEN Sync] Ignored FEN update (sync disabled).");
          }
        });
        console.log("[FEN Sync] Listening for FEN updates from backend.");
      } catch (error) {
        console.error("[FEN Sync] Failed to set up Tauri event listener:", error);
      }
    };

    setupListener();

    // Cleanup function: always runs when effect dependencies change or component unmounts
    return () => {
      if (unlisten) {
        unlisten(); // Call the unlisten function returned by listen()
        console.log("[FEN Sync] Stopped listening for FEN updates.");
      }
    };
    // Re-run effect if store (identity changes) or the enabled setting changes
  }, [store, isFenSyncEnabled, setFen]); // Added setFen dependency

  // This component doesn't render anything itself
  return null;
}

export default FenListener; 