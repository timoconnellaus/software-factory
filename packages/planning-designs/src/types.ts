import type { DesignFinding, DesignPart } from "@software-factory/runner-contract";

/** A design drawn: the SVG, its size, its parts and the layout warnings it saves with. */
export interface Drawn {
  svg: string;
  width: number;
  height: number;
  parts: DesignPart[];
  warnings: DesignFinding[];
}
