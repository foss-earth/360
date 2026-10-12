// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createGlobeViewerInput } from "../src/globeBrowserBindings.js";

const bindings: (() => void)[] = [];
afterEach(() => { bindings.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });

function setup() {
  const canvas = document.createElement("canvas"), cancel = new AbortController(); document.body.append(canvas);
  const binding = createGlobeViewerInput({ getInputMode: () => "touch", setNavigationIntentHandler: () => () => {} }, canvas, () => { throw new Error("No fixture lease attached"); },
    { nowMs: () => 0, controlTakesKey: () => false, abortReason: () => new Error("input") });
  bindings.push(() => binding.dispose());
  return { canvas, cancel, input: binding.input.cancelOnInput(cancel) };
}
const pointer = (pointerType: string, pointerId = 1) => Object.assign(new Event("pointerdown"), { pointerType, pointerId, button: 0, clientX: 2, clientY: 3 });
const touch = (type: string, ...fingers: [number, number, number][]) =>
  Object.assign(new Event(type), { touches: fingers.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) });
/** Runs `body` in a window without touch events, as a desktop browser's is. */
function withoutTouchEvents(body: () => void): void {
  let owner: object | null = window;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "ontouchstart")) owner = Object.getPrototypeOf(owner) as object | null;
  if (!owner) { body(); return; }
  const descriptor = Object.getOwnPropertyDescriptor(owner, "ontouchstart")!;
  delete (owner as { ontouchstart?: unknown }).ontouchstart;
  try { body(); } finally { Object.defineProperty(owner, "ontouchstart", descriptor); }
}

describe("a flight cancelled by touch", () => {
  it("stops on a finger landing and reports every finger down, where it is", () => {
    expect("ontouchstart" in window).toBe(true);
    const { canvas, cancel, input } = setup();
    expect(input.touches?.()).toBeNull();
    canvas.dispatchEvent(touch("touchstart", [7, 10, 20], [9, 30, 40]));
    expect(cancel.signal.aborted).toBe(true);
    expect(input.touches?.()).toEqual([{ identifier: 7, clientX: 10, clientY: 20 }, { identifier: 9, clientX: 30, clientY: 40 }]);
    expect(input.press()).toBeNull();
  });

  it("follows the fingers once one has landed, and not before", () => {
    const { canvas, cancel, input } = setup();
    canvas.dispatchEvent(touch("touchmove", [1, 5, 5]));
    canvas.dispatchEvent(touch("touchend"));
    expect(input.touches?.()).toBeNull();
    expect(cancel.signal.aborted).toBe(false);
    canvas.dispatchEvent(touch("touchstart", [1, 5, 5]));
    canvas.dispatchEvent(touch("touchstart", [1, 6, 6], [2, 50, 60]));
    canvas.dispatchEvent(touch("touchmove", [1, 8, 9], [2, 52, 61]));
    expect(input.touches?.()).toEqual([{ identifier: 1, clientX: 8, clientY: 9 }, { identifier: 2, clientX: 52, clientY: 61 }]);
    canvas.dispatchEvent(touch("touchend", [2, 52, 61]));
    expect(input.touches?.()).toEqual([{ identifier: 2, clientX: 52, clientY: 61 }]);
    canvas.dispatchEvent(touch("touchcancel"));
    expect(input.touches?.()).toEqual([]);
  });

  it("leaves a finger's pointer-down to its touch event when there are touch events", () => {
    const { canvas, cancel, input } = setup();
    canvas.dispatchEvent(pointer("touch"));
    expect(cancel.signal.aborted).toBe(false);
    expect(input.press()).toBeNull();
    expect(input.touches?.()).toBeNull();
  });

  it("still stops on a pen, and on a mouse press, which it keeps for handback", () => {
    const pen = setup();
    pen.canvas.dispatchEvent(pointer("pen"));
    expect(pen.cancel.signal.aborted).toBe(true);
    expect(pen.input.press()).toBeNull();
    const mouse = setup();
    mouse.canvas.dispatchEvent(pointer("mouse", 4));
    expect(mouse.cancel.signal.aborted).toBe(true);
    expect(mouse.input.press()).toEqual({ pointerId: 4, button: 0, clientX: 2, clientY: 3 });
    expect(mouse.input.touches?.()).toBeNull();
  });

  it("stops on a finger's pointer-down where there are no touch events", () => {
    withoutTouchEvents(() => {
      expect("ontouchstart" in window).toBe(false);
      const { canvas, cancel, input } = setup();
      canvas.dispatchEvent(pointer("touch"));
      expect(cancel.signal.aborted).toBe(true);
      expect(input.press()).toBeNull();
    });
    expect("ontouchstart" in window).toBe(true);
  });

  it("stops listening to fingers once stopped", () => {
    const { canvas, cancel, input } = setup();
    input.stop();
    canvas.dispatchEvent(touch("touchstart", [1, 5, 5]));
    canvas.dispatchEvent(touch("touchmove", [1, 6, 6]));
    canvas.dispatchEvent(pointer("mouse"));
    expect(cancel.signal.aborted).toBe(false);
    expect(input.touches?.()).toBeNull();
    expect(input.press()).toBeNull();
  });

  it("stops listening to fingers when the binding retires", () => {
    const { canvas, cancel, input } = setup();
    bindings.splice(0).forEach(dispose => dispose());
    canvas.dispatchEvent(touch("touchstart", [1, 5, 5]));
    expect(cancel.signal.aborted).toBe(false);
    expect(input.touches?.()).toBeNull();
  });
});
