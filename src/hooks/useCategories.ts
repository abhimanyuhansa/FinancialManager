"use client";
import { useState, useEffect } from "react";

export type Category = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  isDefault: boolean;
};

export type SubCategory = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  parentSlug: string;
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

// ── Sub-categories ──────────────────────────────────────────────────────────

const subCache = new Map<string, SubCategory[]>();
const subInflight = new Map<string, Promise<SubCategory[]>>();

async function fetchSubCategories(parentSlug: string): Promise<SubCategory[]> {
  const cached = subCache.get(parentSlug);
  if (cached) return cached;
  let p = subInflight.get(parentSlug);
  if (!p) {
    p = fetch(`/api/subcategories?parent=${encodeURIComponent(parentSlug)}`)
      .then((r) => r.json())
      .then((d: { subCategories: SubCategory[] }) => {
        const result = d.subCategories ?? [];
        subCache.set(parentSlug, result);
        subInflight.delete(parentSlug);
        return result;
      });
    subInflight.set(parentSlug, p);
  }
  return p;
}

export function invalidateSubCategoryCache(parentSlug?: string) {
  if (parentSlug) {
    subCache.delete(parentSlug);
    subInflight.delete(parentSlug);
  } else {
    subCache.clear();
    subInflight.clear();
  }
}

export function useSubCategories(parentSlug: string | null) {
  const existing = parentSlug ? (subCache.get(parentSlug) ?? null) : null;
  const [subCategories, setSubCategories] = useState<SubCategory[]>(existing ?? []);
  const [loading, setLoading] = useState(parentSlug !== null && existing === null);

  useEffect(() => {
    if (!parentSlug) { setSubCategories([]); setLoading(false); return; }
    const cached = subCache.get(parentSlug);
    if (cached) { setSubCategories(cached); setLoading(false); return; }
    setLoading(true);
    fetchSubCategories(parentSlug).then((subs) => { setSubCategories(subs); setLoading(false); });
  }, [parentSlug]);

  const refetch = () => {
    if (!parentSlug) return;
    invalidateSubCategoryCache(parentSlug);
    setLoading(true);
    fetchSubCategories(parentSlug).then((subs) => { setSubCategories(subs); setLoading(false); });
  };

  return { subCategories, loading, refetch };
}
