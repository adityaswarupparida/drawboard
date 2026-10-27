import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { KIND_LABEL, type Annotation, type DiagramNode as DNode, type Severity } from "../../shared/diagram";
import { colorFor } from "../../shared/protocol";
import { KindIcon } from "../icons";

export type DiagramNodeData = {
  node: DNode;
  annotation?: Annotation;
  highlight?: Severity;
  fresh?: boolean;
};
export type DiagramFlowNode = Node<DiagramNodeData, "dnode">;

const SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;

export const authorColor = (by: DNode["by"]) => (by.ai ? "var(--ai)" : colorFor(by.id));

function DiagramNodeView({ data, selected }: NodeProps<DiagramFlowNode>) {
  const { node, annotation, highlight, fresh } = data;
  const color = authorColor(node.by);
  const cls = ["dnode", selected ? "selected" : "", highlight ? `hl-${highlight}` : "", fresh ? "fresh" : ""].join(" ");
  return (
    <div className={cls} style={{ ["--fresh" as string]: color }} title={node.description || undefined}>
      {annotation && (
        <div className={`ann ${annotation.severity}`} title={annotation.detail}>
          {annotation.title}
        </div>
      )}
      <KindIcon kind={node.kind} />
      <div className="text">
        <div className="kind">{KIND_LABEL[node.kind]}</div>
        <div className="name">{node.label}</div>
      </div>
      <span className="by" style={{ background: color }} title={`Added by ${node.by.name}`} />
      {SIDES.map(([id, pos]) => (
        <Handle key={`s-${id}`} id={`s-${id}`} type="source" position={pos} />
      ))}
      {SIDES.map(([id, pos]) => (
        <Handle key={`t-${id}`} id={`t-${id}`} type="target" position={pos} />
      ))}
    </div>
  );
}

export const DiagramNodeComponent = memo(DiagramNodeView);
