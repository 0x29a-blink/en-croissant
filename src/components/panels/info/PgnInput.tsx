import { Textarea } from "@mantine/core";
import { useContext } from "react";
import { TreeContext } from "../../boards/BoardAnalysis";

function PgnInput() {
  const tree = useContext(TreeContext);
  const root = tree.getTopVariation();
  return <Textarea label="PGN" readOnly value={root.getPGN()} />;
}

export default PgnInput;
