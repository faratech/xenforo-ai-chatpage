import type { PCProfile, SupportCase, SupportCaseStatus } from '../services/api';

export const SUPPORT_STATUS_LABELS: Record<SupportCaseStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  archived: 'Archived',
};

export const PC_PROFILE_FIELDS: readonly {
  key: keyof PCProfile;
  label: string;
  placeholder: string;
  numeric?: boolean;
}[] = [
  { key: 'os_name', label: 'Operating system', placeholder: 'Windows 11' },
  { key: 'edition', label: 'Edition', placeholder: 'Pro' },
  { key: 'os_version', label: 'Version', placeholder: '24H2' },
  { key: 'build', label: 'OS build', placeholder: '26100.3915' },
  { key: 'architecture', label: 'Architecture', placeholder: '64-bit' },
  { key: 'device_type', label: 'Device type', placeholder: 'Desktop, laptop, VM…' },
  { key: 'manufacturer', label: 'Manufacturer', placeholder: 'Dell' },
  { key: 'model', label: 'Model', placeholder: 'XPS 15 9530' },
  { key: 'cpu', label: 'Processor', placeholder: 'Intel Core i7-13700H' },
  { key: 'memory_gb', label: 'Memory (GB)', placeholder: '32', numeric: true },
  { key: 'gpu', label: 'Graphics', placeholder: 'NVIDIA RTX 4060' },
] as const;

const escapeBBCodeText = (value: string): string => value
  .split('[').join('［')
  .split(']').join('］');

const listBlock = (heading: string, values: readonly string[]): string[] => {
  if (values.length === 0) return [];
  return [
    `[B]${heading}[/B]`,
    '[LIST]',
    ...values.map(value => `[*]${escapeBBCodeText(value)}`),
    '[/LIST]',
    '',
  ];
};

/** Builds a forum-ready draft. It deliberately never sends or posts it. */
export const buildSupportCaseBBCode = (supportCase: SupportCase): string => {
  const profileRows = PC_PROFILE_FIELDS.flatMap(({ key, label }) => {
    const value = supportCase.pc_profile?.[key];
    if (value === undefined || value === '') return [];
    return [`${label}: ${String(value)}`];
  });

  return [
    `[B]Support case: ${escapeBBCodeText(supportCase.title)}[/B]`,
    '',
    `[B]Case ID:[/B] ${supportCase.id}`,
    `[B]Status:[/B] ${SUPPORT_STATUS_LABELS[supportCase.status]}`,
    '',
    '[B]Problem description[/B]',
    escapeBBCodeText(supportCase.description),
    '',
    ...listBlock('PC profile', profileRows),
    ...listBlock('Linked AI conversation IDs', supportCase.conversation_ids),
    ...listBlock('Attachment IDs', supportCase.attachment_ids),
  ].join('\n').trim();
};
