import { Search, X } from "lucide-react";
import type { CategoryData } from "./types";

interface Props {
  categories: CategoryData[];
  activeCategory: number | null;
  searchQuery: string;
  onSelectCategory: (id: number | null) => void;
  onSearch: (q: string) => void;
}

export function CategoryTabs({
  categories,
  activeCategory,
  searchQuery,
  onSelectCategory,
  onSearch,
}: Props) {
  return (
    <div
      style={{
        backgroundColor: "#faf9f6",
      }}
    >
      {/* Search bar */}
      <div style={{ padding: "12px 16px 10px" }}>
        <div style={{ position: "relative" }}>
          <Search
            style={{
              position: "absolute", left: "14px", top: "50%",
              transform: "translateY(-50%)",
              width: "15px", height: "15px",
              color: "#9ca3af",
              pointerEvents: "none",
            }}
          />
          <input
            type="search"
            inputMode="search"
            placeholder="Search for dishes…"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            className="rounded-full"
            style={{
              width: "100%",
              height: "42px",
              paddingLeft: "42px",
              paddingRight: searchQuery ? "38px" : "16px",
              borderRadius: "9999px",
              border: "1.5px solid #e5e7eb",
              backgroundColor: "#fff",
              color: "#111827",
              fontSize: "14px",
              outline: "none",
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              boxSizing: "border-box",
            }}
          />
          {searchQuery && (
            <button
              onClick={() => onSearch("")}
              style={{
                position: "absolute", right: "13px", top: "50%",
                transform: "translateY(-50%)",
                color: "#9ca3af",
                display: "flex", alignItems: "center",
              }}
            >
              <X style={{ width: "15px", height: "15px" }} />
            </button>
          )}
        </div>
      </div>

      {/* Category pill tabs */}
      {categories.length > 0 && (
        <div style={{
          display: "flex",
          gap: "6px",
          padding: "0 16px 11px",
          overflowX: "auto",
          overscrollBehaviorX: "contain",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        } as React.CSSProperties}>
          {/* "All" pill */}
          <button
            onClick={() => onSelectCategory(null)}
            style={{
              flexShrink: 0,
              padding: "6px 16px",
              borderRadius: "9999px",
              fontSize: "13px",
              fontWeight: activeCategory === null ? 700 : 500,
              whiteSpace: "nowrap",
              backgroundColor: activeCategory === null ? "#3d2012" : "transparent",
              color: activeCategory === null ? "#fff" : "#374151",
              border: activeCategory === null ? "none" : "1px solid transparent",
              transition: "background-color 0.15s",
            }}
          >
            All
          </button>

          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => onSelectCategory(cat.id)}
              style={{
                flexShrink: 0,
                padding: "6px 14px",
                borderRadius: "9999px",
                fontSize: "13px",
                fontWeight: activeCategory === cat.id ? 700 : 500,
                whiteSpace: "nowrap",
                backgroundColor: activeCategory === cat.id ? "#3d2012" : "transparent",
                color: activeCategory === cat.id ? "#fff" : "#374151",
                border: "none",
                transition: "background-color 0.15s",
              }}
            >
              {cat.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
