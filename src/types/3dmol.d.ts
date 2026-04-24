// Minimal module shim — 3Dmol does not ship authoritative typings.
// The Viewer3D component confines all direct usage to one file and treats
// returned objects as loosely-typed viewer/model handles.
declare module "3dmol" {
  // Using `any` deliberately: 3Dmol's API surface is large and partially
  // documented; a precise mapping would be noisy and low-value here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createViewer(element: HTMLElement, options?: Record<string, unknown>): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}
