import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Moseek UI rendering failed", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error === null) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
        <section
          aria-labelledby="app-error-title"
          className="flex w-full max-w-lg flex-col gap-4 rounded-lg border bg-card p-6 shadow-sm"
        >
          <div>
            <p className="text-sm font-medium text-destructive">界面错误</p>
            <h1 id="app-error-title" className="mt-1 text-xl font-semibold">
              Moseek 暂时无法显示这个页面
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              当前页面遇到未处理的界面错误。重新加载不会删除本地配置或脚本档案。
            </p>
          </div>
          <Button type="button" className="w-fit" onClick={this.handleReload}>
            重新加载界面
          </Button>
        </section>
      </main>
    );
  }
}
