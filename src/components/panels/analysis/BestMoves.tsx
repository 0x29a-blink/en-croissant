import {
  Accordion,
  ActionIcon,
  Box,
  Button,
  ChevronIcon,
  Collapse,
  createStyles,
  Flex,
  Group,
  Progress,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconSettings,
  IconTargetArrow
} from "@tabler/icons";
import { invoke } from "@tauri-apps/api";
import { emit, listen } from "@tauri-apps/api/event";
import { Chess } from "chess.js";
import { useContext, useEffect, useState } from "react";
import { EngineVariation, Score, swapMove } from "../../../utils/chess";
import { Engine } from "../../../utils/engines";
import { TreeContext } from "../../boards/BoardAnalysis";
import CoresSlide from "./CoresSlider";
import DepthSlider from "./DepthSlider";
import LinesSlider from "./LinesSlider";

const useStyles = createStyles((theme) => ({
  subtitle: {
    color: theme.fn.rgba(theme.white, 0.65),
  },
}));

function ScoreBubble({ score }: { score: Score }) {
  const scoreNumber = score.cp ?? score.mate;
  let scoreText = "";
  const type = score.cp !== undefined ? "cp" : "mate";
  if (type === "cp") {
    scoreText = Math.abs(scoreNumber / 100).toFixed(2);
  } else {
    scoreText = "M" + Math.abs(scoreNumber);
  }
  if (scoreNumber > 0) {
    scoreText = "+" + scoreText;
  }
  if (scoreNumber < 0) {
    scoreText = "-" + scoreText;
  }
  return (
    <Box
      sx={(theme) => ({
        backgroundColor:
          scoreNumber >= 0 ? theme.colors.gray[0] : theme.colors.dark[9],
        textAlign: "center",
        padding: 5,
        borderRadius: theme.radius.md,
        width: 70,
      })}
    >
      <Text
        weight={700}
        color={scoreNumber >= 0 ? "black" : "white"}
        size="md"
        align="center"
        sx={(theme) => ({
          fontFamily: theme.fontFamilyMonospace,
        })}
      >
        {scoreText}
      </Text>
    </Box>
  );
}

interface BestMovesProps {
  id: number;
  engine: Engine;
  makeMoves: (moves: string[]) => void;
  setArrows: ((arrows: string[]) => void);
}

function BestMoves({ id, makeMoves, engine, setArrows }: BestMovesProps) {
  const tree = useContext(TreeContext);
  const chess = new Chess(tree.fen);
  const half_moves = tree.half_moves;
  const [engineVariations, setEngineVariation] = useState<EngineVariation[]>(
    []
  );
  const [numberLines, setNumberLines] = useState<number>(3);
  const [maxDepth, setMaxDepth] = useState<number>(24);
  const [cores, setCores] = useState<number>(3);
  const [enabled, toggleEnabled] = useToggle();
  const [settingsOn, toggleSettingsOn] = useToggle();
  const [threat, toggleThreat] = useToggle();
  const { classes } = useStyles();
  const depth = engineVariations[0]?.depth ?? 0;
  const nps = Math.floor(engineVariations[0]?.nps / 1000 ?? 0);
  const progress = (depth / maxDepth) * 100;

  async function startEngine() {
    emit("stop_engine", engine.path);
    invoke("get_best_moves", {
      engine: engine.path,
      fen: threat ? swapMove(tree.fen) : tree.fen,
      depth: maxDepth,
      numberLines: Math.min(numberLines, chess.moves().length),
      numberThreads: 2 ** cores,
      relative: !!engine.downloadLink,
    });
  }

  useEffect(() => {
    async function waitForMove() {
      await listen("best_moves", (event) => {
        const ev = event.payload as EngineVariation[];
        if (ev[0].engine === engine.path) {
          setEngineVariation(ev);
          if (id === 0) {
            setArrows(
              ev.map((ev) => {
                return ev.uciMoves[0];
              })
            );
          }
        }
      });
    }
    waitForMove();
  }, []);

  useEffect(() => {
    if (enabled) {
      startEngine();
    } else {
      emit("stop_engine", engine.path);
    }
  }, [tree.fen, enabled, numberLines, maxDepth, cores, threat]);

  function AnalysisRow({
    score,
    moves,
    uciMoves,
    index,
  }: {
    score: Score;
    moves: string[];
    uciMoves: string[];
    index: number;
  }) {
    const currentOpen = open[index];

    return (
      <tr style={{ verticalAlign: "top" }}>
        <td>
          <ScoreBubble score={score} />
        </td>
        <td>
          <Flex
            direction="row"
            wrap="wrap"
            sx={{
              height: currentOpen ? "100%" : 35,
              overflow: "hidden",
            }}
          >
            {moves.map((move, index) => {
              const total_moves = half_moves + index + 1 + (threat ? 1 : 0);
              const is_black = total_moves % 2 === 1;
              const move_number = Math.ceil(total_moves / 2);

              return (
                <MoveCell
                  moveNumber={move_number}
                  isBlack={is_black}
                  moves={uciMoves}
                  move={move}
                  index={index}
                  key={total_moves + move}
                />
              );
            })}
          </Flex>
        </td>
        <td>
          <ActionIcon
            style={{
              transition: "transform 200ms ease",
              transform: currentOpen ? `rotate(180deg)` : "none",
            }}
            onClick={() =>
              setOpen((prev) => {
                return {
                  ...prev,
                  [index]: !prev[index],
                };
              })
            }
          >
            <ChevronIcon />
          </ActionIcon>
        </td>
      </tr>
    );
  }

  function MoveCell({
    moves,
    move,
    index,
    isBlack,
    moveNumber,
  }: {
    moves: string[];
    move: string;
    index: number;
    isBlack: boolean;
    moveNumber: number;
  }) {
    const first = index === 0;
    return (
      <Button
        variant="subtle"
        onClick={() => {
          if (!threat) makeMoves(moves.slice(0, index + 1));
        }}
      >
        {(isBlack || first) && <span>{moveNumber.toFixed(0) + "."}</span>}
        {first && !isBlack && ".."}
        {move}
      </Button>
    );
  }

  const [open, setOpen] = useState<boolean[]>([]);

  return (
    <Accordion.Item value={engine.name}>
      <Box sx={{ display: "flex", alignItems: "center" }}>
        <ActionIcon
          size="lg"
          onClick={() => {
            if (progress === 100) {
              startEngine();
            } else {
              toggleEnabled();
            }
          }}
          ml={8}
        >
          {enabled && progress < 100 ? (
            <IconPlayerPause size={16} />
          ) : (
            <IconPlayerPlay size={16} />
          )}
        </ActionIcon>
        <Accordion.Control disabled={!enabled && engineVariations.length === 0}>
          <Group position="apart">
            <Group align="baseline">
              <Text fw="bold" fz="xl">
                {engine.name}
              </Text>
              {progress < 100 && enabled && (
                <Tooltip label={"How fast the engine is running"}>
                  <Text>{nps}k nodes/s</Text>
                </Tooltip>
              )}
            </Group>
            <Stack align="center" spacing={0}>
              <Text
                size="xs"
                transform="uppercase"
                weight={700}
                className={classes.subtitle}
              >
                Depth
              </Text>
              <Text fw="bold" fz="xl">
                {depth}
              </Text>
            </Stack>
          </Group>
        </Accordion.Control>
        <Tooltip label="Check the opponent's threat">
          <ActionIcon size="lg" onClick={() => toggleThreat()}>
            <IconTargetArrow color={threat ? "red" : "white"} size={16} />
          </ActionIcon>
        </Tooltip>
        <ActionIcon size="lg" onClick={() => toggleSettingsOn()} mr={8}>
          <IconSettings size={16} />
        </ActionIcon>
      </Box>
      <Collapse in={settingsOn} px={30} pb={15}>
        <Group grow>
          <Text size="sm" fw="bold">
            Number of Lines
          </Text>
          <LinesSlider value={numberLines} setValue={setNumberLines} />
        </Group>
        <Group grow>
          <Text size="sm" fw="bold">
            Engine Depth
          </Text>
          <DepthSlider value={maxDepth} setValue={setMaxDepth} />
        </Group>
        <Group grow>
          <Text size="sm" fw="bold">
            Number of cores
          </Text>
          <CoresSlide value={cores} setValue={setCores} />
        </Group>
      </Collapse>

      <Progress
        value={progress}
        animate={progress < 100 && enabled}
        size="xs"
        striped={progress < 100 && !enabled}
        color={threat ? "red" : "blue"}
      />
      <Accordion.Panel>
        <Table>
          <tbody>
            {engineVariations.length === 0 &&
              Array.apply(null, Array(numberLines)).map((_, i) => (
                <tr key={i}>
                  <td>
                    <Skeleton height={50} radius="xl" p={5} />
                  </td>
                </tr>
              ))}
            {engineVariations.map((engineVariation, index) => {
              return (
                <AnalysisRow
                  key={engineVariation.sanMoves.join("")}
                  score={engineVariation.score}
                  moves={engineVariation.sanMoves}
                  uciMoves={engineVariation.uciMoves}
                  index={index}
                />
              );
            })}
          </tbody>
        </Table>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

export default BestMoves;
