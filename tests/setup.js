/**
 * Node 環境には Path2D が無いため、グリッドの generateCells() を動かすための
 * 最小スタブを提供する。描画はテストしない（geometry ベースで検証する）ので、
 * 呼び出しを記録するだけでよい。
 */
class Path2DStub {
  constructor() {
    this.ops = [];
  }
  rect(...args) {
    this.ops.push(['rect', ...args]);
  }
  arc(...args) {
    this.ops.push(['arc', ...args]);
  }
  ellipse(...args) {
    this.ops.push(['ellipse', ...args]);
  }
  moveTo(...args) {
    this.ops.push(['moveTo', ...args]);
  }
  lineTo(...args) {
    this.ops.push(['lineTo', ...args]);
  }
  bezierCurveTo(...args) {
    this.ops.push(['bezierCurveTo', ...args]);
  }
  quadraticCurveTo(...args) {
    this.ops.push(['quadraticCurveTo', ...args]);
  }
  closePath() {
    this.ops.push(['closePath']);
  }
  addPath(other) {
    this.ops.push(['addPath', other]);
  }
}

globalThis.Path2D = Path2DStub;
