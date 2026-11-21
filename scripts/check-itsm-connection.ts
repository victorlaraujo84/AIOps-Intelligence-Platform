import { parseItsmDestination, readPrivateItsmFile } from '../src/server/itsm-config.ts';
import { createItsmAdapter } from '../src/server/itsm-http.ts';

async function main(file: string | undefined, externalId: string | undefined) {
  if (!file || !externalId || process.argv.length !== 4) {
    throw new Error('Uso: node --import tsx scripts/check-itsm-connection.ts ARQUIVO_PRIVADO ID_DE_TESTE');
  }
  const destination = parseItsmDestination(await readPrivateItsmFile(file), false);
  const result = await createItsmAdapter(destination).getTicket(externalId);
  if (result.ok) {
    console.log(`${destination.provider} get_ticket verificado com um registro existente.`);
  } else {
    console.error(`Consulta ITSM falhou (${result.code}).`);
    process.exitCode = 1;
  }
}

main(process.argv[2], process.argv[3]).catch(() => {
  console.error('Confira os argumentos, as permissões do arquivo e a configuração do destino ITSM.');
  process.exitCode = 1;
});
