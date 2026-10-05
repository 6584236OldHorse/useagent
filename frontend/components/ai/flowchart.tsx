"use client";

// Adapted from Beautiful UI Flowchart, MIT License.
// Copyright (c) 2026 Shane Levine.
// Exact upstream source: vendor/beautiful-ui/sources/flowchart.tsx.txt,
// pinned to slev12397/beautiful-ui@ff0f74d62d8be9d89bcb735b3632e31a6ccf88dc.
// Keeps the draggable nodes and measured connector; uses the shared Select,
// Button, Chip, icon set, and theme tokens. Node handles also support keyboard movement.

import { RiDraggable, RiFlashlightLine, RiRestartLine } from "@remixicon/react";
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import { cx } from "@/utils/cx";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type NodeId = "trigger" | "condition";

const NODES = [
  { id: "trigger", label: "Trigger", width: 300, color: "purple" },
  { id: "condition", label: "If / Else", width: 356, color: "orange" },
] as const;
const NODE_HEADER_HEIGHT = 30;
const CANVAS_PADDING = 24;
const NODE_GAP = 64;

const FIELDS = [
  { id: "flavor", options: ["Rocky Road", "Mint Chip", "Pistachio", "Bubblegum"] },
  {
    id: "topping",
    options: [
      "Brown butter bourbon brittle crunch",
      "Rainbow sprinkles",
      "Hot fudge",
      "Candied pecans",
    ],
  },
  { id: "size", options: ["Small", "Medium", "Large"] },
  { id: "scoops", options: ["1", "2", "3"] },
];

/** Keep the complete node and its label inside the canvas, including after a resize. */
export function clampFlowchartPosition(position: Point, canvas: Size, node: Size): Point {
  const inset = 8;
  return {
    x: Math.max(inset, Math.min(position.x, Math.max(inset, canvas.width - node.width - inset))),
    y: Math.max(inset, Math.min(position.y, Math.max(inset, canvas.height - node.height - inset))),
  };
}

export function flowchartConnector(from: Point, to: Point): string {
  const bend = Math.min(Math.max(Math.abs(to.y - from.y) * 0.55, 24), 84);
  const direction = Math.sign(to.y - from.y) || 1;
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + direction * bend}, ${to.x} ${to.y - direction * bend}, ${to.x} ${to.y}`;
}

function ConditionRow({ label, initialField }: { label: string; initialField: string }) {
  const [field, setField] = useState(FIELDS.find(({ id }) => id === initialField) ?? FIELDS[0]);
  const [value, setValue] = useState(field.options[0]);

  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-2">
      <span className="pt-1.5 text-body-2-regular text-text-secondary">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip color="soft" className="rounded-lg">
          order
        </Chip>
        <Select
          aria-label={`${label} condition field`}
          size="sm"
          selectedKey={field.id}
          className="w-24"
          onSelectionChange={(key) => {
            const next = FIELDS.find(({ id }) => id === key);
            if (next) {
              setField(next);
              setValue(next.options[0]);
            }
          }}
        >
          {FIELDS.map(({ id }) => (
            <SelectItem key={id} id={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
        <span className="text-body-2-regular text-text-secondary">is</span>
        <Select
          aria-label={`${label} condition value`}
          size="sm"
          selectedKey={value}
          className={cx(
            "min-w-0 max-w-full flex-1",
            field.id === "topping" ? "basis-full" : "basis-24",
          )}
          onSelectionChange={(key) => {
            if (typeof key === "string") setValue(key);
          }}
        >
          {field.options.map((option) => (
            <SelectItem key={option} id={option}>
              {option}
            </SelectItem>
          ))}
        </Select>
      </div>
    </div>
  );
}

export function Flowchart({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<NodeId, HTMLDivElement>());
  const [measurement, setMeasurement] = useState({ width: 480, trigger: 112, condition: 172 });
  const [offsets, setOffsets] = useState<Partial<Record<NodeId, Point>>>({});
  const [selected, setSelected] = useState<NodeId | null>(null);
  const drag = useRef<{ id: NodeId; pointerId: number; start: Point; position: Point } | null>(
    null,
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const width = canvas.clientWidth;
      const trigger = nodeRefs.current.get("trigger")?.offsetHeight ?? 112;
      const condition = nodeRefs.current.get("condition")?.offsetHeight ?? 172;
      setMeasurement((previous) =>
        previous.width === width && previous.trigger === trigger && previous.condition === condition
          ? previous
          : { width, trigger, condition },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    for (const node of nodeRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const canvasHeight = measurement.trigger + measurement.condition + NODE_GAP + CANVAS_PADDING * 2;
  const canvasSize = { width: measurement.width, height: canvasHeight };
  const placements = NODES.map((node) => {
    const width = Math.min(node.width, Math.max(0, measurement.width - 32));
    const base = {
      x: (measurement.width - width) / 2,
      y: CANVAS_PADDING + (node.id === "condition" ? measurement.trigger + NODE_GAP : 0),
    };
    const offset = offsets[node.id] ?? { x: 0, y: 0 };
    const size = { width, height: measurement[node.id] };
    const position = clampFlowchartPosition(
      { x: base.x + offset.x, y: base.y + offset.y },
      canvasSize,
      size,
    );
    return { ...node, ...position, size, base };
  });
  const [trigger, condition] = placements;

  const move = (id: NodeId, position: Point) => {
    const node = placements.find((item) => item.id === id);
    if (!node) return;
    const next = clampFlowchartPosition(position, canvasSize, node.size);
    setOffsets((current) => ({
      ...current,
      [id]: { x: next.x - node.base.x, y: next.y - node.base.y },
    }));
  };

  const startDrag = (id: NodeId, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const node = placements.find((item) => item.id === id);
    if (!node) return;
    drag.current = {
      id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      position: node,
    };
    setSelected(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    move(current.id, {
      x: current.position.x + event.clientX - current.start.x,
      y: current.position.y + event.clientY - current.start.y,
    });
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const moveWithKeyboard = (id: NodeId, event: KeyboardEvent<HTMLButtonElement>) => {
    const directions: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const direction = directions[event.key];
    const node = placements.find((item) => item.id === id);
    if (!direction || !node) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    setSelected(id);
    move(id, { x: node.x + direction.x * step, y: node.y + direction.y * step });
  };

  return (
    <div className={cx("space-y-3", className)}>
      <div
        ref={canvasRef}
        role="group"
        aria-label="Agent workflow"
        className="relative w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-secondary-default"
        style={{
          height: canvasHeight,
          backgroundImage:
            "radial-gradient(var(--color-border-button-default) 1px, transparent 1.25px)",
          backgroundSize: "22px 22px",
        }}
      >
        <svg
          aria-hidden="true"
          width="100%"
          height={canvasHeight}
          className="pointer-events-none absolute inset-0"
        >
          <path
            d={flowchartConnector(
              { x: trigger.x + trigger.size.width / 2, y: trigger.y + trigger.size.height },
              { x: condition.x + condition.size.width / 2, y: condition.y + NODE_HEADER_HEIGHT },
            )}
            fill="none"
            stroke={selected ? "var(--color-text-accent)" : "var(--color-text-tertiary)"}
            strokeWidth="1.25"
          />
        </svg>
        {placements.map((node) => (
          <div
            key={node.id}
            ref={(element) => {
              if (element) nodeRefs.current.set(node.id, element);
              else nodeRefs.current.delete(node.id);
            }}
            className="absolute flex flex-col gap-1.5"
            style={{
              left: node.x,
              top: node.y,
              width: node.size.width,
              zIndex: selected === node.id ? 2 : 1,
            }}
          >
            <div className="flex h-6 items-center justify-between">
              <Chip color={node.color} className="rounded-lg">
                {node.label}
              </Chip>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                leadingIcon={RiDraggable}
                aria-label={`Move ${node.label} node`}
                title="Drag or use arrow keys; hold Shift for 1px steps"
                className="touch-none cursor-grab rounded-lg active:cursor-grabbing"
                onPointerDown={(event) => startDrag(node.id, event)}
                onPointerMove={moveDrag}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onLostPointerCapture={() => {
                  drag.current = null;
                }}
                onKeyDown={(event) => moveWithKeyboard(node.id, event)}
              />
            </div>
            {node.id === "trigger" ? (
              <button
                type="button"
                aria-pressed={selected === "trigger"}
                onClick={() => setSelected(selected === "trigger" ? null : "trigger")}
                className="flex w-full items-center gap-2.5 rounded-2xl border border-border-button-default bg-background-primary-default p-3 text-left shadow-card outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-status-purple-background text-status-purple-text">
                  <RiFlashlightLine className="size-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-body-2-medium text-text-primary">
                    New order created
                  </span>
                  <span className="mt-0.5 block text-caption-1-regular text-text-secondary">
                    Trigger when a new order is created
                  </span>
                </span>
              </button>
            ) : (
              <div className="space-y-2 rounded-2xl border border-border-button-default bg-background-primary-default p-3 shadow-card">
                <ConditionRow label="If" initialField="flavor" />
                <ConditionRow label="and" initialField="topping" />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-caption-1-regular text-text-secondary">
          Drag a handle or focus it and use the arrow keys.
        </p>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiRestartLine}
          onClick={() => {
            setOffsets({});
            setSelected(null);
          }}
        >
          Reset layout
        </Button>
      </div>
    </div>
  );
}
