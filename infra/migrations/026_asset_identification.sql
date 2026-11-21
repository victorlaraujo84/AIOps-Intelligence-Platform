GRANT SELECT (ip_address, vendor, model, provider_name, redundancy_group),
      INSERT (ip_address, vendor, model, provider_name, redundancy_group),
      UPDATE (ip_address, vendor, model, provider_name, redundancy_group)
ON public.assets TO aiops_asset_writer;
