"use client";

import { FolderIcon, HomeIcon } from "lucide-react";
import type { Folder } from "@/lib/api";
import { folderTree } from "@/lib/files";
import { cn } from "@/lib/utils";

/** The picker value for the top level; folder ids are never empty. */
export const TOP_LEVEL = "";

/** A picker value as a backend parentId: null for the top level. */
export const toParentId = (value: string) => (value === TOP_LEVEL ? null : value);

interface FolderPickerProps {
  /** Radio group name; unique per dialog. */
  name: string;
  folders: Folder[];
  /** Where the item lives now (TOP_LEVEL or a folder id); shown as Current location. */
  current: string;
  /** The picked destination, or null before one is picked. */
  value: string | null;
  onChange: (value: string) => void;
  /** Folders that can't be picked: a moving folder and its subfolders. */
  unavailable?: ReadonlySet<string>;
  /** The folder being moved, labelled in the list so the disabled branch reads clearly. */
  self?: string;
  disabled?: boolean;
  error?: string | null;
  errorId: string;
}

/** An indented destination list: the top level, then every folder depth-first. */
export function FolderPicker({
  name,
  folders,
  current,
  value,
  onChange,
  unavailable,
  self,
  disabled,
  error,
  errorId,
}: FolderPickerProps) {
  const options = [
    { value: TOP_LEVEL, name: "Top level", depth: 0, Icon: HomeIcon },
    ...folderTree(folders).map(({ folder, depth }) => ({
      value: folder.id,
      name: folder.name,
      depth: depth + 1,
      Icon: FolderIcon,
    })),
  ];

  return (
    <fieldset className="grid gap-2" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-2 text-sm font-medium">Destination</legend>
      <div className="max-h-72 overflow-y-auto rounded-md border p-1">
        {options.map(({ value: option, name: optionName, depth, Icon }) => {
          const isCurrent = option === current;
          const isSelf = option === self;
          const blocked = isCurrent || !!unavailable?.has(option);
          return (
            <label
              key={option || "top"}
              className={cn(
                "flex items-center gap-2 rounded-md py-2 pr-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
                blocked ? "text-muted-foreground" : "cursor-pointer hover:bg-accent/60 has-[:checked]:bg-accent",
              )}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
            >
              <input
                type="radio"
                name={name}
                value={option}
                className="sr-only"
                checked={value === option}
                disabled={blocked || disabled}
                onChange={() => onChange(option)}
              />
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className={cn("truncate", !blocked && "font-medium")}>{optionName}</span>
              {isCurrent ? (
                <span className="label-caps ml-auto shrink-0">Current location</span>
              ) : isSelf ? (
                <span className="label-caps ml-auto shrink-0">Moving</span>
              ) : blocked ? (
                <span className="sr-only">(inside the folder being moved)</span>
              ) : null}
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
