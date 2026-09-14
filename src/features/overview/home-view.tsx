import {
  Activity,
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  Database,
  Download,
  ExternalLink,
  Film,
  Radio,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { CapabilityBadge } from "@/components/capability-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getCapabilityCounts,
  recentActivity,
  recentPlays,
} from "@/lib/mock-data";
import { useAppStore } from "@/stores/app-store";

export function HomeView() {
  const sources = useAppStore((state) => state.sources);
  const counts = getCapabilityCounts(sources);
  const enabledCount = sources.filter((source) => source.enabled).length;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-6 px-8 py-8">
        <section className="flex items-end justify-between gap-8">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2">
              <Badge
                variant="secondary"
                className="gap-1.5 bg-accent text-accent-foreground"
              >
                <Sparkles data-icon="inline-start" aria-hidden="true" />
                周一，9 月 14 日
              </Badge>
              <span className="text-xs text-muted-foreground">
                上次同步 2 分钟前
              </span>
            </div>
            <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
              今天从哪里开始？
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              你的影视源、直播和播放记录都在这里。Moseek
              会把兼容边界说清楚，再把可用内容交到你手里。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="gap-2">
              <Download data-icon="inline-start" aria-hidden="true" />
              导出报告
            </Button>
            <Button type="button" className="gap-2">
              <Film data-icon="inline-start" aria-hidden="true" />
              继续播放
            </Button>
          </div>
        </section>

        <Alert className="border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]">
          <ShieldCheck data-icon="inline-start" aria-hidden="true" />
          <AlertTitle>工作区运行正常</AlertTitle>
          <AlertDescription className="text-[color:var(--status-supported)]/80">
            已检查 {sources.length} 个源，其中 {enabledCount}{" "}
            个已启用。未授权的本机服务与远程脚本仍保持关闭。
          </AlertDescription>
        </Alert>

        <section className="grid grid-cols-4 gap-4" aria-label="资源源统计">
          <MetricCard
            label="可用资源源"
            value={counts.supported}
            hint="普通 CMS 与直播源"
            icon={Check}
            tone="supported"
          />
          <MetricCard
            label="部分支持"
            value={counts.partial}
            hint="API 可用，依赖被隔离"
            icon={CircleAlert}
            tone="partial"
          />
          <MetricCard
            label="需要适配"
            value={counts["needs-adapter"]}
            hint="私有协议暂不执行"
            icon={Activity}
            tone="adapter"
          />
          <MetricCard
            label="默认阻止"
            value={counts.blocked + counts.invalid}
            hint="脚本或配置存在风险"
            icon={TriangleAlert}
            tone="blocked"
          />
        </section>

        <section className="grid grid-cols-[1.15fr_0.85fr] gap-6">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/25">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database data-icon="inline-start" aria-hidden="true" />
                    源健康状态
                  </CardTitle>
                  <CardDescription className="mt-1">
                    最近请求成功率与能力分类
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground"
                >
                  查看全部
                  <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">资源源</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">最近检查</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sources.slice(0, 5).map((source) => (
                    <TableRow key={source.key}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
                            {source.sourceType === "live" ? (
                              <Radio
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                            ) : (
                              <Film
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                            )}
                          </span>
                          <div>
                            <p className="font-medium">{source.name}</p>
                            <p className="max-w-56 truncate text-xs text-muted-foreground">
                              {source.api}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {source.sourceType === "cms"
                          ? "普通 CMS"
                          : source.sourceType === "live"
                            ? "直播"
                            : "解析"}
                      </TableCell>
                      <TableCell>
                        <CapabilityBadge status={source.capability} />
                      </TableCell>
                      <TableCell className="pr-6 text-right text-xs text-muted-foreground">
                        {source.lastCheckedAt}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock3 data-icon="inline-start" aria-hidden="true" />
                最近播放
              </CardTitle>
              <CardDescription>从上次离开的地方继续</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {recentPlays.map((play) => (
                <div key={play.title} className="group flex gap-3">
                  <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-muted">
                    <img
                      src={play.poster}
                      alt={`${play.title} 海报`}
                      className="size-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-background/70">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${play.progress}%` }}
                      />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-sm font-medium">
                        {play.title}
                      </p>
                      <ArrowUpRight
                        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                        data-icon="inline-end"
                        aria-hidden="true"
                      />
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {play.duration}
                    </p>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground/75">
                      {play.source}
                    </p>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="mt-1 w-full gap-2"
              >
                查看播放历史
                <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="grid grid-cols-[0.9fr_1.1fr] gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Radio data-icon="inline-start" aria-hidden="true" />
                直播速览
              </CardTitle>
              <CardDescription>收藏频道和节目单状态</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <MiniStat label="频道" value="86" detail="4 个分组" />
              <MiniStat label="EPG" value="92%" detail="最近同步 18 分钟前" />
              <MiniStat label="收藏" value="12" detail="3 个正在直播" />
              <MiniStat
                label="失败请求"
                value="3"
                detail="需要查看诊断"
                danger
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity data-icon="inline-start" aria-hidden="true" />
                最近活动
              </CardTitle>
              <CardDescription>配置、请求和播放事件</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-52">
                <div className="px-6 pb-3">
                  {recentActivity.map((activity) => (
                    <div
                      key={activity.id}
                      className="flex items-center gap-3 border-b py-3 last:border-0"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                        {activity.status === "success" ? (
                          <Check data-icon="inline-start" aria-hidden="true" />
                        ) : activity.status === "warning" ? (
                          <CircleAlert
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        ) : (
                          <TriangleAlert
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {activity.action}{" "}
                          <span className="font-normal text-muted-foreground">
                            · {activity.target}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {activity.detail}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {activity.time}
                      </span>
                    </div>
                  ))}
                </div>
                <ScrollBar />
              </ScrollArea>
            </CardContent>
          </Card>
        </section>

        <footer className="flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
          <span>Moseek v0.1 · 本地数据工作区</span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-[color:var(--status-supported)]" />
            Rust 网络层待接入
            <ExternalLink data-icon="inline-end" aria-hidden="true" />
          </span>
        </footer>
      </div>
      <ScrollBar />
    </ScrollArea>
  );
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  icon: typeof Check;
  tone: "supported" | "partial" | "adapter" | "blocked";
}) {
  const toneClasses = {
    supported:
      "bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
    partial:
      "bg-[color:var(--status-partial-bg)] text-[color:var(--status-partial)]",
    adapter:
      "bg-[color:var(--status-adapter-bg)] text-[color:var(--status-adapter)]",
    blocked:
      "bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
  };

  return (
    <Card className="border-border/80 shadow-none">
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-tight">
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </div>
        <div
          className={`flex size-9 items-center justify-center rounded-md ${toneClasses[tone]}`}
        >
          <Icon data-icon="inline-start" aria-hidden="true" />
        </div>
      </CardContent>
    </Card>
  );
}

function MiniStat({
  label,
  value,
  detail,
  danger = false,
}: {
  label: string;
  value: string;
  detail: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/25 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-2 font-display text-2xl font-semibold ${danger ? "text-destructive" : "text-foreground"}`}
      >
        {value}
      </p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}
