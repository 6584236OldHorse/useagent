import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { clampFlowchartPosition, Flowchart, flowchartConnector } from "./flowchart";

test("dragging and resizing keep a complete node inside the canvas", () => {
  const canvas = { width: 480, height: 400 };
  const node = { width: 300, height: 100 };
  expect(clampFlowchartPosition({ x: -50, y: -20 }, canvas, node)).toEqual({ x: 8, y: 8 });
  expect(clampFlowchartPosition({ x: 500, y: 600 }, canvas, node)).toEqual({ x: 172, y: 292 });
  expect(clampFlowchartPosition({ x: 100, y: 150 }, canvas, node)).toEqual({ x: 100, y: 150 });
  expect(
    clampFlowchartPosition(
      { x: 172, y: 100 },
      { width: 280, height: 400 },
      { width: 248, height: 100 },
    ),
  ).toEqual({ x: 24, y: 100 });
});

test("the connector follows moved node anchors", () => {
  expect(flowchartConnector({ x: 240, y: 112 }, { x: 240, y: 200 })).toBe(
    "M 240 112 C 240 160.4, 240 151.6, 240 200",
  );
  expect(flowchartConnector({ x: 100, y: 200 }, { x: 320, y: 400 })).toBe(
    "M 100 200 C 100 284, 320 316, 320 400",
  );
  expect(flowchartConnector({ x: 320, y: 400 }, { x: 100, y: 200 })).toBe(
    "M 320 400 C 320 316, 100 284, 100 200",
  );
});

test("the lab flowchart renders connected steps and keyboard-reachable controls", () => {
  const html = renderToStaticMarkup(<Flowchart />);
  expect(html).toContain("New order created");
  expect(html).toContain("If / Else");
  expect(html).toContain('aria-label="Move Trigger node"');
  expect(html).toContain('aria-label="Move If / Else node"');
  expect(html).toContain("If condition field");
  expect(html).toContain("and condition value");
  expect(html).toContain("Reset layout");
});
