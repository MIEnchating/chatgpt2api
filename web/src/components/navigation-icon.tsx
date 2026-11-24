import { BooksIcon } from "@phosphor-icons/react/dist/csr/Books";
import { BoundingBoxIcon } from "@phosphor-icons/react/dist/csr/BoundingBox";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { ScrollIcon } from "@phosphor-icons/react/dist/csr/Scroll";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { UsersThreeIcon } from "@phosphor-icons/react/dist/csr/UsersThree";
import { cn } from "@/lib/utils";

const navigationIcons = {
  home: HouseIcon,
  canvas: BoundingBoxIcon,
  workflow: TreeStructureIcon,
  book: BooksIcon,
  folder: FolderOpenIcon,
  users: UsersThreeIcon,
  shield: ShieldCheckIcon,
  logs: ScrollIcon,
  settings: GearSixIcon,
};

export type NavigationIconName = keyof typeof navigationIcons;

export function NavigationIcon({ name, active = false, className }: { name: NavigationIconName; active?: boolean; className?: string }) {
  const Icon = navigationIcons[name];
  return <Icon className={cn("dark:text-white", className)} weight={active ? "fill" : "regular"} aria-hidden="true" />;
}
