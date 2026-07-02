import { Component, type ReactNode } from "react";

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** A rendering error in one section must degrade to a visible, recoverable
 * message — never a silently blank page (which is exactly how the invisible-
 * grid bug read to users). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[lumina] ${this.props.label} crashed:`, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
          <p className="text-sm font-medium text-text-1">
            Something went wrong showing {this.props.label}.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-2 transition-colors hover:bg-surface-2"
          >
            Reload the page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
