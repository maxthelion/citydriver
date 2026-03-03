export class GameMode {
  constructor(name) {
    this.name = name;
    this.active = true;
  }
  cityGenerated(game) {}
  update(dt, game) {}
  drawMinimap(ctx, game) {}
  cleanup(game) {}
}
