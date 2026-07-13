"use client";
import { useState, useEffect } from "react";

export type Category = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  isDefault: boolean;
};

let cache: Category[] | null = null;
let inflight: Promise<Category[]> | null = null;

async function fetchCategories(): Promise<Category[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = fetch("/api/categories")
      .then((r) => r.json())
      .then((d: { categories: Category[] }) => {
        cache = d.categories ?? [];
        inflight = null;
        return cache;
      });
  }
  return inflight;
}

export function invalidateCategoryCache() {
  cache = null;
  inflight = null;
}

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    if (cache) { setCategories(cache); setLoading(false); return; }
    fetchCategories().then((cats) => { setCategories(cats); setLoading(false); });
  }, []);

  const refetch = () => {
    invalidateCategoryCache();
    setLoading(true);
    fetchCategories().then((cats) => { setCategories(cats); setLoading(false); });
  };

  return { categories, loading, refetch };
}
