-- ARQUIVO HISTÓRICO: origem legada read-only; não participa do runtime.
ALTER TABLE public.product_ingredients ADD COLUMN IF NOT EXISTS price_updated_at timestamptz;
ALTER TABLE public.product_packaging ADD COLUMN IF NOT EXISTS price_updated_at timestamptz;

UPDATE public.product_ingredients SET price_updated_at = created_at WHERE price_updated_at IS NULL;
UPDATE public.product_packaging SET price_updated_at = created_at WHERE price_updated_at IS NULL;

CREATE OR REPLACE FUNCTION public.set_price_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.price_updated_at = COALESCE(NEW.price_updated_at, now());
  ELSIF NEW.package_price IS DISTINCT FROM OLD.package_price THEN
    NEW.price_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ingredients_price_updated_at ON public.product_ingredients;
CREATE TRIGGER trg_ingredients_price_updated_at
BEFORE INSERT OR UPDATE ON public.product_ingredients
FOR EACH ROW EXECUTE FUNCTION public.set_price_updated_at();

DROP TRIGGER IF EXISTS trg_packaging_price_updated_at ON public.product_packaging;
CREATE TRIGGER trg_packaging_price_updated_at
BEFORE INSERT OR UPDATE ON public.product_packaging
FOR EACH ROW EXECUTE FUNCTION public.set_price_updated_at();
