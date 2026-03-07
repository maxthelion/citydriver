/**
 * CityScreen stub — 3D city view (not yet implemented in v5).
 * Redirects to debug viewer for now.
 */

import { DebugScreen } from './DebugScreen.js';

export class CityScreen {
  constructor(container, layers, settlement, rng, seed, onBack) {
    // V5: redirect to debug viewer until 3D rendering is built
    this._debug = new DebugScreen(container, layers, settlement, seed, onBack);
  }

  dispose() {
    if (this._debug) {
      this._debug.dispose();
      this._debug = null;
    }
  }
}
