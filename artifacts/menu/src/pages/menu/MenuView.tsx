import { useLocation } from "wouter";
import { UtensilsCrossed, ShoppingBag, Receipt } from "lucide-react";
import { MenuHeader } from "./MenuHeader";
import { CategoryTabs } from "./CategoryTabs";
import { MenuItemList } from "./MenuItemList";
import { CartBar } from "./CartBar";
import type { RestaurantData, CategoryData, MenuItemData, OrderType } from "./types";

interface Props {
  restaurant: RestaurantData;
  categories: CategoryData[];
  filteredCategories: CategoryData[];
  allItems: MenuItemData[];
  activeCategory: number | null;
  searchQuery: string;
  orderType: OrderType | null;
  manualTableNumber: string;
  takeAwayOnly: boolean;
  itemCount: number;
  subtotal: number;
  tableId?: string;
  getQty: (id: number) => number;
  onAdd: (item: MenuItemData) => void;
  onRemove: (itemId: number) => void;
  onSelectCategory: (id: number | null) => void;
  onSearch: (q: string) => void;
  onChangeMode: () => void;
  onOpenCart: () => void;
  onMyOrders?: () => void;
}

export function MenuView({
  restaurant,
  categories,
  filteredCategories,
  allItems,
  activeCategory,
  searchQuery,
  orderType,
  manualTableNumber,
  takeAwayOnly,
  itemCount,
  subtotal,
  tableId,
  getQty,
  onAdd,
  onRemove,
  onSelectCategory,
  onSearch,
  onChangeMode,
  onOpenCart,
  onMyOrders,
}: Props) {
  const [, setLocation] = useLocation();

  const modeLabel =
    orderType === "take_away"
      ? "Take Away"
      : `${restaurant.seatingLabel ?? "Table"} ${manualTableNumber}`;

  return (
    <div className="min-h-dvh" style={{ backgroundColor: "#faf9f6" }}>
      {/* ── Restaurant branding header (scrolls normally) ────── */}
      <MenuHeader
        restaurant={restaurant}
        orderType={orderType}
        manualTableNumber={manualTableNumber}
        takeAwayOnly={takeAwayOnly}
        onChangeMode={onChangeMode}
        tableId={tableId}
        onMyOrders={onMyOrders}
      />

      {/* ── Sticky stacked container: Persistent Nav + Category Tabs ── */}
      <div
        className="sticky top-0 z-20"
        style={{
          backgroundColor: "#faf9f6",
          paddingTop: "env(safe-area-inset-top, 0px)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.07)",
        }}
      >
        {/* Persistent compact navigation row */}
        <div
          style={{
            height: "44px",
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            maxWidth: "640px",
            margin: "0 auto",
            borderBottom: "1px solid #ede8e3",
            backgroundColor: "#faf9f6",
          }}
        >
          {/* Left: Mode context + Change button */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexShrink: 1 }}>
            <span
              style={{
                backgroundColor: "#fff",
                border: "1px solid #e5e0d8",
                borderRadius: "20px",
                padding: "3px 10px",
                color: "#1a0a00",
                fontSize: "12px",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                gap: "5px",
                whiteSpace: "nowrap",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
            >
              {orderType === "take_away" ? (
                <ShoppingBag style={{ width: "12px", height: "12px", color: "#ea580c" }} />
              ) : (
                <UtensilsCrossed style={{ width: "12px", height: "12px", color: "#ea580c" }} />
              )}
              {modeLabel}
            </span>
            {!takeAwayOnly && (
              <button
                onClick={onChangeMode}
                style={{
                  color: "#ea580c",
                  fontSize: "12px",
                  fontWeight: 600,
                  textDecoration: "underline",
                  padding: "4px 2px",
                  cursor: "pointer",
                  border: "none",
                  backgroundColor: "transparent",
                  flexShrink: 0,
                }}
              >
                change
              </button>
            )}
          </div>

          {/* Right: My Orders button */}
          <button
            onClick={
              onMyOrders ??
              (() => {
                const q = new URLSearchParams();
                q.set("rid", restaurant.id.toString());
                if (tableId) q.set("tid", tableId);
                if (orderType) q.set("mode", orderType);
                setLocation(`/my-orders?${q.toString()}`);
              })
            }
            aria-label="My Orders"
            title="My Orders"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              height: "32px",
              padding: "0 10px",
              borderRadius: "16px",
              backgroundColor: "#fff",
              border: "1px solid #e5e0d8",
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              flexShrink: 0,
              cursor: "pointer",
              color: "#1a0a00",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            <Receipt style={{ width: "14px", height: "14px", color: "#ea580c" }} />
            <span>My Orders</span>
          </button>
        </div>

        {/* Sticky Category Tabs (search & categories) */}
        <CategoryTabs
          categories={categories}
          activeCategory={activeCategory}
          searchQuery={searchQuery}
          onSelectCategory={onSelectCategory}
          onSearch={onSearch}
        />
      </div>

      <MenuItemList
        filteredCategories={filteredCategories}
        allItems={allItems}
        searchQuery={searchQuery}
        getQty={getQty}
        onAdd={onAdd}
        onRemove={onRemove}
      />
      <CartBar itemCount={itemCount} subtotal={subtotal} onOpen={onOpenCart} />
    </div>
  );
}
