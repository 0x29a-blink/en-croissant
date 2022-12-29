import {
  ActionIcon,
  AspectRatio,
  Box,
  Card,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Tooltip
} from "@mantine/core";
import { useLocalStorage, useToggle } from "@mantine/hooks";
import {
  IconChessBishop,
  IconChessKnight,
  IconChessQueen,
  IconChessRook,
  IconEdit,
  IconSwitchVertical
} from "@tabler/icons";
import { BISHOP, Chess, KING, KNIGHT, QUEEN, ROOK, Square } from "chess.js";
import { Color } from "chessground/types";
import { useContext, useState } from "react";
import Chessground from "react-chessground";
import { formatMove, moveToKey, parseUci, toDests } from "../utils/chess";
import { TreeContext } from "./BoardAnalysis";
import OpeningName from "./OpeningName";

interface ChessboardProps {
  arrows: string[];
  makeMove: (move: { from: Square; to: Square; promotion?: string }) => void;
}

const promotionPieces = [
  {
    piece: QUEEN,
    icon: <IconChessQueen size={50} />,
  },

  {
    piece: ROOK,
    icon: <IconChessRook size={50} />,
  },

  {
    piece: KNIGHT,
    icon: <IconChessKnight size={50} />,
  },

  {
    piece: BISHOP,
    icon: <IconChessBishop size={50} />,
  },
];

function Chessboard({ arrows, makeMove }: ChessboardProps) {
  const tree = useContext(TreeContext);
  const chess = new Chess(tree.fen);
  const lastMove = tree.move;
  const [showDests] = useLocalStorage<boolean>({
    key: "show-dests",
    defaultValue: true,
  });
  const [showArrows] = useLocalStorage<boolean>({
    key: "show-arrows",
    defaultValue: true,
  });
  const [autoPromote] = useLocalStorage<boolean>({
    key: "auto-promote",
    defaultValue: true,
  });
  const fen = chess.fen();
  const dests = toDests(chess);
  const turn = formatMove(chess.turn());
  const [pendingMove, setPendingMove] = useState<{
    from: Square;
    to: Square;
  } | null>(null);
  const [orientation, toggleOrientation] = useToggle<Color>(["white", "black"]);
  const [editingMode, toggleEditingMode] = useToggle();

  return (
    <Stack justify="center">
      {editingMode && (
        <Card shadow="sm">
          <Group position="center">
            <p>HORSE</p>
            <p>HORSE</p>
            <p>HORSE</p>
            <p>HORSE</p>
          </Group>
        </Card>
      )}

      <div style={{ aspectRatio: 1, position: "relative", zIndex: 1 }}>
        <Modal
          opened={pendingMove !== null}
          onClose={() => setPendingMove(null)}
          withCloseButton={false}
          size={375}
        >
          <SimpleGrid cols={2}>
            {promotionPieces.map((p) => (
              <Box sx={{ width: "100%", height: "100%" }}>
                <AspectRatio ratio={1}>
                  <ActionIcon
                    onClick={() => {
                      makeMove({
                        from: pendingMove!.from,
                        to: pendingMove!.to,
                        promotion: p.piece,
                      });
                      setPendingMove(null);
                    }}
                  >
                    {p.icon}
                  </ActionIcon>
                </AspectRatio>
              </Box>
            ))}
          </SimpleGrid>
        </Modal>

        <Chessground
          style={{ justifyContent: "start" }}
          width={"100%"}
          height={"100%"}
          orientation={orientation}
          fen={fen}
          movable={{
            free: false,
            color: turn,
            dests: dests,
            showDests,
            events: {
              after: (orig, dest, metadata) => {
                if (orig === "a0" || dest === "a0") {
                  // NOTE: Idk if this can happen
                  return;
                }
                if (chess.get(orig)?.type === KING) {
                  switch (dest) {
                    case "h1":
                      dest = "g1";
                      break;
                    case "a1":
                      dest = "c1";
                      break;
                    case "h8":
                      dest = "g8";
                      break;
                    case "a8":
                      dest = "c8";
                      break;
                  }
                }
                // handle promotions
                if (
                  (dest[1] === "8" && turn === "white") ||
                  (dest[1] === "1" && turn === "black")
                ) {
                  if (autoPromote && !metadata.ctrlKey) {
                    makeMove({
                      from: orig,
                      to: dest,
                      promotion: QUEEN,
                    });
                  } else {
                    setPendingMove({ from: orig, to: dest });
                  }
                } else {
                  makeMove({
                    from: orig,
                    to: dest,
                  });
                }
              },
            },
          }}
          turnColor={turn}
          check={chess.inCheck()}
          lastMove={moveToKey(lastMove)}
          drawable={{
            enabled: true,
            visible: true,
            defaultSnapToValidMove: true,
            eraseOnClick: true,
            autoShapes:
              showArrows && arrows.length > 0
                ? arrows.map((move, i) => {
                    const { from, to } = parseUci(move);
                    return {
                      orig: from,
                      dest: to,
                      brush: i === 0 ? "paleBlue" : "paleGrey",
                    };
                  })
                : [],
          }}
        />
      </div>

      <Group position={"apart"}>
        <OpeningName />

        <Group>
          <ActionIcon onClick={() => toggleEditingMode()}>
            <IconEdit />
          </ActionIcon>
          <Tooltip label={"Flip Board"}>
            <ActionIcon onClick={() => toggleOrientation()}>
              <IconSwitchVertical />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </Stack>
  );
}

export default Chessboard;
