import type { DesktopNavigationTarget } from './contracts.js';

const MAX_PENDING_NAVIGATIONS = 20;

export class DesktopNavigationQueue {
  private pending: DesktopNavigationTarget[] = [];
  private rendererReady = false;

  enqueue(target: DesktopNavigationTarget): void {
    if (this.pending.length >= MAX_PENDING_NAVIGATIONS) this.pending.shift();
    this.pending.push(target);
  }

  markRendererReady(): DesktopNavigationTarget[] {
    this.rendererReady = true;
    return this.pending.splice(0);
  }

  resetRenderer(): void {
    this.rendererReady = false;
  }

  takeReady(): DesktopNavigationTarget[] {
    if (!this.rendererReady) return [];
    return this.pending.splice(0);
  }
}
