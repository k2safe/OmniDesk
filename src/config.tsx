import { Shield, Smartphone, Bookmark, BookOpen, Code, CalendarHeart, Wrench, Timer } from "lucide-react";
import { View } from "./types";
import React from "react";

export const ALL_APPS: { id: View; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "vault", label: "保险箱", icon: <Shield />, desc: "凭据与私密文件" },
  { id: "totp", label: "验证器", icon: <Smartphone />, desc: "两步验证代码" },
  { id: "bookmarks", label: "全局书签", icon: <Bookmark />, desc: "网址与导航" },
  { id: "notes", label: "知识库", icon: <BookOpen />, desc: "智能备忘录" },
  { id: "snippets", label: "代码块", icon: <Code />, desc: "本地代码片段" },
  { id: "subscriptions", label: "订阅管理", icon: <CalendarHeart />, desc: "续费周期追踪" },
  { id: "devtools", label: "极客工具", icon: <Wrench />, desc: "数据转换与测试" },
  { id: "pomodoro", label: "番茄钟", icon: <Timer />, desc: "专注时间管理" },
];
