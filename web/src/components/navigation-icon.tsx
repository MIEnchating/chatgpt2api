import { BookOpenText, FolderOpen, Home, ScrollText, Settings, ShieldCheck, SquareDashedMousePointer, Users, Workflow } from "lucide-react";

const navigationIcons = {
  home: { outline: Home, solid: "M11.1 2.7a1.4 1.4 0 0 1 1.8 0l8 6.6a1.4 1.4 0 0 1-.9 2.5h-1v8.1a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 19.9v-8.1H4a1.4 1.4 0 0 1-.9-2.5l8-6.6ZM10 14v7h4v-7h-4Z" },
  canvas: { outline: SquareDashedMousePointer, solid: "M5 3h12a2 2 0 0 1 2 2v7.4l-7-3.6v11H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8.5 8.2 8 4.2-3.6 1.1-1.4 4.2-3-9.5Z" },
  workflow: { outline: Workflow, solid: "M4 2.5h6A1.5 1.5 0 0 1 11.5 4v6a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 10V4A1.5 1.5 0 0 1 4 2.5Zm10 10h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5ZM6 11.5h2v4A1.5 1.5 0 0 0 9.5 17h3v2h-3A3.5 3.5 0 0 1 6 15.5v-4Z" },
  book: { outline: BookOpenText, solid: "M3.5 3H8a5 5 0 0 1 3.3 1.2V21A6.2 6.2 0 0 0 7 19.5H3.5A1.5 1.5 0 0 1 2 18V4.5A1.5 1.5 0 0 1 3.5 3Zm12.5 0h4.5A1.5 1.5 0 0 1 22 4.5V18a1.5 1.5 0 0 1-1.5 1.5H17a6.2 6.2 0 0 0-4.3 1.5V4.2A5 5 0 0 1 16 3ZM5 7v1.5h4V7H5Zm0 4v1.5h4V11H5Zm10-4v1.5h4V7h-4Zm0 4v1.5h4V11h-4Z" },
  folder: { outline: FolderOpen, solid: "M3.5 4h5.2l2.4 2.5H20A2 2 0 0 1 22 8.5v1H6l-4 9V5.5A1.5 1.5 0 0 1 3.5 4ZM6.8 11H23l-3.6 8.2a1.6 1.6 0 0 1-1.5 1H3l3.8-9.2Z" },
  users: { outline: Users, solid: "M9 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm8 1a3.5 3.5 0 0 1 0 7c-.4 0-.8-.1-1.1-.2a6 6 0 0 0 0-6.6c.3-.1.7-.2 1.1-.2ZM2 20v-1a7 7 0 0 1 14 0v1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 20Zm14-6.7a5.5 5.5 0 0 1 6 5.5v.7a1.5 1.5 0 0 1-1.5 1.5H18v-2a9 9 0 0 0-2-5.7Z" },
  shield: { outline: ShieldCheck, solid: "m12 2 8.5 3.4v6.1c0 5.2-4.2 8.8-8.5 10.5-4.3-1.7-8.5-5.3-8.5-10.5V5.4L12 2Zm-1.1 13.9 6-6-1.4-1.4-4.6 4.6-2.4-2.4-1.4 1.4 3.8 3.8Z" },
  logs: { outline: ScrollText, solid: "M5 2.5h13a2 2 0 0 1 2 2v13H9V20a2.5 2.5 0 0 1-5 0V6H2V5.5a3 3 0 0 1 3-3Zm5 4v1.5h7V6.5h-7Zm0 4v1.5h7v-1.5h-7ZM11 19h11v1a2.5 2.5 0 0 1-2.5 2.5H9.7A4.5 4.5 0 0 0 11 20v-1Z" },
  settings: { outline: Settings, solid: "M9 2h6v3l2 1 2-2 3 5-2 1v4l2 1-3 5-2-2-2 1v3H9v-3l-2-1-2 2-3-5 2-1v-4l-2-1 3-5 2 2 2-1V2Zm3 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" },
};

export type NavigationIconName = keyof typeof navigationIcons;

export function NavigationIcon({ name, active = false, className }: { name: NavigationIconName; active?: boolean; className?: string }) {
  const { outline: Outline, solid } = navigationIcons[name];
  if (!active) return <Outline className={className} aria-hidden="true" data-navigation-icon="outline" />;
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" className={className} aria-hidden="true" data-navigation-icon="solid"><path d={solid} fillRule="evenodd" clipRule="evenodd" /></svg>;
}
