-- ARQUIVO HISTÓRICO: origem legada read-only; não participa do runtime.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.set_updated_at() SET search_path = public;
