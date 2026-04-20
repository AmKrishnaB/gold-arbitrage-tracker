-- Migration: add three-field pricing breakdown to products.
-- See src/config/types.ts (NormalizedProduct.listedPrice/promoDiscount/bankDiscount).
--
-- Runtime fallback: src/db/index.ts also runs these ALTER TABLEs via ensureColumn()
-- on every initDB(), so DBs created without drizzle-kit will still pick up the columns.
ALTER TABLE `products` ADD COLUMN `listed_price` REAL;--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `promo_discount` REAL;--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `bank_discount` REAL;
