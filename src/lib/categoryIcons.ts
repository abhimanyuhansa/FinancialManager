export type IconGroup = {
  label: string;
  icons: Array<{ name: string; label: string }>;
};

export const ICON_GROUPS: IconGroup[] = [
  {
    label: "Food & Drink",
    icons: [
      { name: "ForkKnife",    label: "Food"      },
      { name: "Coffee",       label: "Coffee"    },
      { name: "Pizza",        label: "Pizza"     },
      { name: "Hamburger",    label: "Burger"    },
      { name: "Cookie",       label: "Snacks"    },
      { name: "Wine",         label: "Drinks"    },
      { name: "IceCream",     label: "Dessert"   },
      { name: "Basket",       label: "Groceries" },
    ],
  },
  {
    label: "Transport",
    icons: [
      { name: "Car",          label: "Car"       },
      { name: "Bus",          label: "Bus"       },
      { name: "Train",        label: "Train"     },
      { name: "Airplane",     label: "Flight"    },
      { name: "Bicycle",      label: "Cycle"     },
      { name: "Motorcycle",   label: "Bike"      },
      { name: "GasPump",      label: "Petrol"    },
      { name: "Taxi",         label: "Taxi"      },
    ],
  },
  {
    label: "Home & Bills",
    icons: [
      { name: "House",        label: "Rent"      },
      { name: "Lightning",    label: "Electric"  },
      { name: "WifiHigh",     label: "Internet"  },
      { name: "Phone",        label: "Phone"     },
      { name: "Wrench",       label: "Repairs"   },
      { name: "Drop",         label: "Water"     },
      { name: "FireSimple",   label: "Gas"       },
      { name: "Television",   label: "OTT"       },
    ],
  },
  {
    label: "Shopping",
    icons: [
      { name: "ShoppingCart", label: "Shopping"  },
      { name: "TShirt",       label: "Clothing"  },
      { name: "Sneaker",      label: "Shoes"     },
      { name: "Handbag",      label: "Bags"      },
      { name: "Package",      label: "Delivery"  },
      { name: "Tag",          label: "Deals"     },
    ],
  },
  {
    label: "Finance",
    icons: [
      { name: "Wallet",           label: "Wallet"   },
      { name: "TrendUp",          label: "Invest"   },
      { name: "CreditCard",       label: "Card"     },
      { name: "PiggyBank",        label: "Savings"  },
      { name: "Bank",             label: "Bank"     },
      { name: "ChartBar",         label: "Analytics"},
      { name: "Coins",            label: "Cash"     },
      { name: "ArrowsLeftRight",  label: "Transfer" },
    ],
  },
  {
    label: "Health",
    icons: [
      { name: "Heart",       label: "Health"    },
      { name: "Pill",        label: "Medicine"  },
      { name: "Stethoscope", label: "Doctor"    },
      { name: "Barbell",     label: "Gym"       },
      { name: "Bandaids",    label: "First Aid" },
      { name: "Brain",       label: "Mental"    },
    ],
  },
  {
    label: "Work & Learning",
    icons: [
      { name: "Briefcase",   label: "Work"     },
      { name: "Laptop",      label: "Tech"     },
      { name: "BookOpen",    label: "Learning" },
      { name: "Certificate", label: "Course"   },
      { name: "PenNib",      label: "Writing"  },
      { name: "Toolbox",     label: "Tools"    },
    ],
  },
  {
    label: "Lifestyle",
    icons: [
      { name: "User",           label: "Personal" },
      { name: "GameController", label: "Gaming"   },
      { name: "MusicNote",      label: "Music"    },
      { name: "FilmSlate",      label: "Movies"   },
      { name: "PawPrint",       label: "Pets"     },
      { name: "Baby",           label: "Kids"     },
      { name: "Gift",           label: "Gifts"    },
      { name: "Suitcase",       label: "Travel"   },
    ],
  },
];

const PALETTE = [
  "#04B488", "#5b7cfa", "#ed5533", "#f59e0b",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

export function initialsColor(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) & 0xffffffff;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function categoryInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
