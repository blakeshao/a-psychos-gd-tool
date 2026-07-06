// Style-aware path painting onto a 2D canvas — the one place fill / stroke /
// synthetic-weight semantics live, shared by Rasterize and the element
// renderer so a vector looks the same wherever it lands.

import { DEFAULT_STYLE, type PathCmd, type Style } from '../engine/values';

export function appendPath(p: Path2D, cmds: PathCmd[]) {
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M': p.moveTo(cmd.x, cmd.y); break;
      case 'L': p.lineTo(cmd.x, cmd.y); break;
      case 'C': p.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
      case 'Q': p.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y); break;
      case 'Z': p.closePath(); break;
    }
  }
}

/**
 * Paint one combined path. Order: outside-aligned stroke first (the opaque
 * fill covers its inner half), then fill, then synthetic weight (grow > 0
 * fattens with a same-color stroke; grow < 0 erodes the rim via
 * destination-out — callers sharing a canvas must isolate such draws on
 * their own layer), then a center/inside stroke on top. Aligned strokes are
 * drawn at double width so exactly one half survives the cover/clip.
 */
export function paintPath(
  c2d: OffscreenCanvasRenderingContext2D,
  p: Path2D,
  style: Style = DEFAULT_STYLE,
) {
  c2d.lineJoin = 'round';
  const w = style.strokeWidth;

  const strokeInk = () => {
    c2d.strokeStyle = style.stroke;
    c2d.stroke(p);
  };

  if (w > 0 && style.strokeAlign === 'outside') {
    c2d.lineWidth = w * 2;
    strokeInk();
  }

  c2d.fillStyle = style.fill;
  c2d.fill(p);

  if (style.grow > 0) {
    c2d.strokeStyle = style.fill;
    c2d.lineWidth = style.grow * 2; // a stroke straddles the edge — half lands outside
    c2d.stroke(p);
  } else if (style.grow < 0) {
    c2d.globalCompositeOperation = 'destination-out';
    c2d.lineWidth = -style.grow * 2;
    c2d.stroke(p);
    c2d.globalCompositeOperation = 'source-over';
  }

  if (w > 0 && style.strokeAlign === 'center') {
    c2d.lineWidth = w;
    strokeInk();
  } else if (w > 0 && style.strokeAlign === 'inside') {
    c2d.save();
    c2d.clip(p); // nonzero — the ink region, holes excluded
    c2d.lineWidth = w * 2;
    strokeInk();
    c2d.restore();
  }
}
