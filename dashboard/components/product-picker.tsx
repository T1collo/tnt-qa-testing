"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Product } from "@/components/run-mode-dialog";

type Props = {
  products: Product[];
  selected: string[];
  onChange: (gtins: string[]) => void;
  /** Explains how several products are used by the chosen scope. */
  hint: string;
};

// Multi-select dropdown: the ~80-product catalogue lives in a popover with search, so the
// form itself stays short and never needs its own scroll area.
export function ProductPicker({ products, selected, onChange, hint }: Props) {
  const [query, setQuery] = useState("");
  const id = useId();
  const byGtin = useMemo(() => new Map(products.map((p) => [p.gtin, p])), [products]);
  const chosen = new Set(selected);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      [p.brand, p.generic, p.gtin, p.productId].some((v) => v?.toLowerCase().includes(q))
    );
  }, [products, query]);

  function toggle(gtin: string) {
    onChange(chosen.has(gtin) ? selected.filter((g) => g !== gtin) : [...selected, gtin]);
  }

  const summary =
    selected.length === 0
      ? "Default product"
      : selected.length === 1
        ? (byGtin.get(selected[0])?.brand ?? selected[0])
        : `${selected.length} products selected`;

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={`${id}-trigger`}>Products</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id={`${id}-trigger`}
            type="button"
            variant="outline"
            className="h-9 w-full justify-between font-normal"
            aria-describedby={`${id}-hint`}
          >
            <span className="truncate">{summary}</span>
            <ChevronDown className="text-muted-foreground" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0">
          <div className="relative border-b">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, generic or GTIN"
              aria-label="Search products"
              autoComplete="off"
              className="rounded-b-none border-0 pl-8 shadow-none focus-visible:ring-inset"
            />
          </div>
          <ul aria-label="Product catalogue" className="max-h-72 divide-y overflow-y-auto">
            {visible.map((product) => {
              const checkboxId = `${id}-${product.productId}-${product.gtin}`;
              return (
                <li key={checkboxId}>
                  <label
                    htmlFor={checkboxId}
                    className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 transition-colors duration-(--duration-quick) hover:bg-accent"
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={chosen.has(product.gtin)}
                      onCheckedChange={() => toggle(product.gtin)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{product.brand}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {product.generic}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {product.gtin}
                    </span>
                  </label>
                </li>
              );
            })}
            {visible.length === 0 && (
              <li className="px-3 py-3 text-sm text-muted-foreground">
                {products.length === 0 ? "Loading products…" : `No product matches “${query}”.`}
              </li>
            )}
          </ul>
          <div className="flex items-center justify-between border-t px-3 py-1.5">
            <span className="text-xs text-muted-foreground tabular-nums">
              {selected.length} of {products.length} selected
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
            >
              Clear
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {selected.length > 1 && (
        <ul aria-label="Selected products" className="flex flex-wrap gap-1.5">
          {selected.map((gtin) => {
            const name = byGtin.get(gtin)?.brand ?? gtin;
            return (
              <li
                key={gtin}
                className="flex min-w-0 items-center gap-1 rounded-md border border-selected/70 bg-selected/10 py-0.5 pr-0.5 pl-2 text-xs text-selected"
              >
                <span className="max-w-48 truncate" title={`${name} — ${gtin}`}>
                  {name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => toggle(gtin)}
                  aria-label={`Remove ${name}`}
                  className="text-selected hover:bg-selected/15 hover:text-selected"
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
