import {
  Check,
  MonitorCog,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ThemeMode } from "@/types/moseek";

interface SettingsViewProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}

export function SettingsView({ theme, onThemeChange }: SettingsViewProps) {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-8 py-8">
        <div>
          <p className="text-sm font-medium text-primary">系统偏好</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            设置
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            控制主题、播放行为和本机访问边界。
          </p>
        </div>

        <Tabs defaultValue="appearance" className="flex flex-col gap-6">
          <TabsList className="w-fit">
            <TabsTrigger value="appearance">外观</TabsTrigger>
            <TabsTrigger value="player">播放器</TabsTrigger>
            <TabsTrigger value="security">安全与网络</TabsTrigger>
            <TabsTrigger value="storage">存储</TabsTrigger>
          </TabsList>

          <TabsContent
            value="appearance"
            className="grid grid-cols-[1.2fr_0.8fr] gap-6"
          >
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MonitorCog data-icon="inline-start" aria-hidden="true" />
                  主题模式
                </CardTitle>
                <CardDescription>默认跟随 Windows 系统外观。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Select
                  value={theme}
                  onValueChange={(value) => onThemeChange(value as ThemeMode)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择主题" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="system">
                        <span className="flex items-center gap-2">
                          <MonitorCog
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          跟随系统
                        </span>
                      </SelectItem>
                      <SelectItem value="light">
                        <span className="flex items-center gap-2">
                          <Sun data-icon="inline-start" aria-hidden="true" />
                          浅色
                        </span>
                      </SelectItem>
                      <SelectItem value="dark">
                        <span className="flex items-center gap-2">
                          <Moon data-icon="inline-start" aria-hidden="true" />
                          深色
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">
                  应用会在下次启动时保留你的选择。
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">界面状态</CardTitle>
                <CardDescription>当前工作区的显示信息</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">界面字体</span>
                  <span className="font-medium">IBM Plex Sans</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">动画时长</span>
                  <span className="font-medium">160–240ms</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">缩放比例</span>
                  <span className="font-medium">100%</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="player" className="grid grid-cols-2 gap-6">
            <PreferenceCard
              title="播放行为"
              description="控制播放器开始播放前后的行为"
            >
              <PreferenceRow label="自动记忆播放进度" checked />
              <PreferenceRow label="默认跳过片头" />
              <PreferenceRow label="播放失败时自动切换线路" />
            </PreferenceCard>
            <PreferenceCard
              title="播放质量"
              description="播放器只会使用已解析出的安全地址"
            >
              <PreferenceRow label="优先选择高清线路" checked />
              <PreferenceRow label="允许 HTTP 播放地址" checked />
              <PreferenceRow label="使用外部播放器" />
            </PreferenceCard>
          </TabsContent>

          <TabsContent value="security" className="grid grid-cols-2 gap-6">
            <PreferenceCard
              title="本机与局域网"
              description="这些选项默认关闭，开启前会显示风险提示"
            >
              <PreferenceRow label="允许访问 127.0.0.1" />
              <PreferenceRow label="允许访问局域网地址" />
              <PreferenceRow label="允许本机服务依赖" />
            </PreferenceCard>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                  执行边界
                </CardTitle>
                <CardDescription>
                  导入配置不会改变这些默认规则。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  远程 JavaScript、JAR 和 spider 默认阻止
                </p>
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  日志会隐藏 token、Cookie 和密钥
                </p>
                <p className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 shrink-0 text-[color:var(--status-supported)]"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  外部播放器只在用户主动触发时打开
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="storage" className="grid grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">本地路径</CardTitle>
                <CardDescription>
                  缓存和下载目录将在 Rust 存储层接入后生效。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="rounded-md border bg-muted/25 p-3">
                  <p className="text-xs text-muted-foreground">缓存位置</p>
                  <p className="mt-1 font-medium">
                    %LOCALAPPDATA%\Moseek\cache
                  </p>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <p className="text-xs text-muted-foreground">下载位置</p>
                  <p className="mt-1 font-medium">
                    %USERPROFILE%\Downloads\Moseek
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  数据清理
                </CardTitle>
                <CardDescription>
                  只清理本地缓存，不会删除原始配置文件。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline">
                  清理请求缓存
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function PreferenceCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">{children}</CardContent>
    </Card>
  );
}

function PreferenceRow({
  label,
  checked = false,
}: {
  label: string;
  checked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md px-2 py-3 hover:bg-muted/50">
      <span className="text-sm">{label}</span>
      <Switch defaultChecked={checked} aria-label={label} />
    </div>
  );
}
