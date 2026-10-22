import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '1.0.0:2',
  releaseNotes: {
    en_US:
      'Upgrade the container runtime to Alpine 3.21 and distrust compromised eMudhra (emSign) root CAs.',
    es_ES:
      'Actualiza el entorno de contenedor a Alpine 3.21 y revoca la confianza en las CA raíz comprometidas de eMudhra (emSign).',
    de_DE:
      'Aktualisiert die Container-Laufzeitumgebung auf Alpine 3.21 und entzieht kompromittierten eMudhra (emSign) Root-CAs das Vertrauen.',
    pl_PL:
      'Aktualizuje środowisko kontenera do Alpine 3.21 i wycofuje zaufanie dla skompromitowanych głównych urzędów certyfikacji eMudhra (emSign).',
    fr_FR:
      'Met à niveau l’environnement d’exécution du conteneur vers Alpine 3.21 et révoque la confiance accordée aux autorités de certification racines eMudhra (emSign) compromises.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
