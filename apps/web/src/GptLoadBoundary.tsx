import { Component, type ReactNode } from "react";
export class GptLoadBoundary extends Component<
  { children: ReactNode; onCodex: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="boot-screen" role="alert">
        <p>Не удалось загрузить GPT</p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Обновить
        </button>
        <button type="button" onClick={this.props.onCodex}>
          Вернуться в Codex
        </button>
      </main>
    );
  }
}
