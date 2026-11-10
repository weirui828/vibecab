import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "@wei/design-system";

/**
 * Keeps one broken page from blanking the whole app: the sidebar stays, and the page says what happened with a
 * way to carry on. The work itself is safe in the engine; only this view stopped.
 */
export class PageBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("VibeCab page error", error, info.componentStack);
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="vc-page">
        <div className="vc-broken" role="alert">
          <h1 className="vc-display">This page stopped.</h1>
          <p className="vc-muted" style={{ margin: 0 }}>
            Your work is safe. Load the page again, or go to another page.
          </p>
          <pre>{error.message}</pre>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Load again
          </Button>
        </div>
      </div>
    );
  }
}
