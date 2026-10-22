import { useEffect, useRef, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ChatAPI, type SupportCase } from '../services/api';
import { SUPPORT_OUTCOMES } from './SupportResponseDetails';

export function GuidedSupportPanel({ activeCase, onSelect, onUpdated, disabled, onManage }: {
  activeCase?: SupportCase;
  onSelect: (supportCase: SupportCase | null) => void;
  onUpdated: (supportCase: SupportCase) => void;
  disabled: boolean;
  onManage: () => void;
}) {
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [build, setBuild] = useState('');
  const [changes, setChanges] = useState('');
  const [facts, setFacts] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const factsEdit = useRef<{ caseId?: string; dirty: boolean }>({ dirty: false });
  useEffect(() => {
    const controller = new AbortController();
    const loadCases = async () => {
      const first = await ChatAPI.listSupportCases({ signal: controller.signal, limit: 50 });
      const second = first.next_cursor ? await ChatAPI.listSupportCases({ signal: controller.signal, limit: 50, cursor: first.next_cursor }) : undefined;
      return [...first.cases, ...(second?.cases ?? [])];
    };
    void loadCases().then(result => { if (!controller.signal.aborted) setCases(result); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load support cases. You can continue chatting.'); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (factsEdit.current.caseId === activeCase?.id && factsEdit.current.dirty) return;
    factsEdit.current = { caseId: activeCase?.id, dirty: false };
    setFacts(activeCase?.progress?.confirmed_facts.join('\n') ?? '');
    setChanges(activeCase?.progress?.recent_changes ?? '');
  }, [activeCase?.id, activeCase?.revision, activeCase?.progress]);
  const saveFacts = async () => {
    if (!activeCase) return;
    const confirmed = facts.split('\n').map(line => line.trim()).filter(Boolean);
    const encoder = new TextEncoder();
    if (confirmed.length > 30 || confirmed.some(line => encoder.encode(line).byteLength > 500) || encoder.encode(changes).byteLength > 4000) {
      setError('Use at most 30 facts of 500 UTF-8 bytes each, and 4,000 bytes for recent changes.'); return;
    }
    setBusy(true); setError('');
    try {
      const result = await ChatAPI.updateSupportCaseProgress(activeCase.id, activeCase.revision, {
        confirmed_facts: confirmed, recent_changes: changes,
        attempts: activeCase.progress?.attempts ?? [],
      });
      factsEdit.current.dirty = false;
      onUpdated(result.case);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save case facts.'); }
    finally { setBusy(false); }
  };
  return <Accordion defaultExpanded={!activeCase} disableGutters variant="outlined" sx={{ mx: { xs: 1, sm: 2 }, mt: 1, flexShrink: 0 }}>
    <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography sx={{ fontWeight: 600 }}>{activeCase ? `Troubleshooting: ${activeCase.title}` : 'Troubleshoot Windows'}</Typography></AccordionSummary>
    <AccordionDetails sx={{ maxHeight: '45dvh', overflowY: 'auto' }}><Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">Choose a case to include its reviewed PC details and previous results in your answers.</Typography>
      <TextField select size="small" label="Support case" value={activeCase?.id ?? ''} disabled={disabled || busy} onChange={event => {
        const selected = cases.find(item => item.id === event.target.value);
        if (selected) void ChatAPI.getSupportCase(selected.id).then(result => onSelect(result.case)).catch(cause => setError(String(cause)));
      }}>
        <MenuItem value="">Choose a case</MenuItem>
        {[...new Map([...(activeCase ? [activeCase] : []), ...cases].map(item => [item.id, item])).values()].map(item => <MenuItem key={item.id} value={item.id}>{item.title}</MenuItem>)}
      </TextField>
      {activeCase && <>
        <Typography variant="body2">{activeCase.description}</Typography>
        <Typography variant="caption">{Object.values(activeCase.pc_profile ?? {}).join(' · ') || 'PC details not supplied'} · Revision {activeCase.revision}</Typography>
        <TextField size="small" multiline minRows={2} label="Confirmed facts (one per line)" value={facts} onChange={event => { factsEdit.current.dirty = true; setFacts(event.target.value); }} disabled={disabled || busy} slotProps={{ htmlInput: { maxLength: 12000 } }} />
        <TextField size="small" multiline label="Recent changes" value={changes} onChange={event => { factsEdit.current.dirty = true; setChanges(event.target.value); }} disabled={disabled || busy} slotProps={{ htmlInput: { maxLength: 4000 } }} />
        <Button size="small" disabled={disabled || busy} onClick={() => void saveFacts()}>Save reviewed facts</Button>
        <Button size="small" disabled={disabled || busy} onClick={() => {
          setBusy(true); setError('');
          void ChatAPI.getSupportCase(activeCase.id).then(result => { factsEdit.current.dirty = false; onUpdated(result.case); })
            .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not reload the saved case.'))
            .finally(() => setBusy(false));
        }}>Reload saved case</Button>
        {activeCase.progress?.attempts.map(attempt => <Box key={attempt.id}>
          <Typography variant="body2"><strong>{attempt.check}</strong> · {SUPPORT_OUTCOMES[attempt.outcome]}</Typography>
          {attempt.observed_result && <Typography variant="body2">{attempt.observed_result}</Typography>}
        </Box>)}
      </>}
      {!creating ? <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button size="small" disabled={disabled || busy} onClick={() => setCreating(true)}>New guided case</Button>
        <Button size="small" onClick={onManage}>Manage cases and forum draft</Button>
        {activeCase && <Button size="small" disabled={disabled || busy} onClick={() => onSelect(null)}>Return to ordinary chat</Button>}
      </Box> : <>
        <TextField size="small" multiline minRows={2} label="What is going wrong?" value={description} onChange={event => setDescription(event.target.value)} slotProps={{ htmlInput: { maxLength: 4000 } }} />
        <TextField size="small" label="Windows version" placeholder="Windows 11 24H2" value={version} onChange={event => setVersion(event.target.value)} slotProps={{ htmlInput: { maxLength: 100 } }} />
        <TextField size="small" label="OS build (optional)" value={build} onChange={event => setBuild(event.target.value)} slotProps={{ htmlInput: { maxLength: 100 } }} />
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" disabled={disabled || busy || !description.trim()} onClick={() => {
            setBusy(true); setError('');
            void ChatAPI.upsertSupportCase({ title: description.trim().slice(0, 100), description: description.trim(), pc_profile: { os_name: 'Windows', os_version: version, build } }, 0)
              .then(result => { setCases(previous => [result.case, ...previous]); onSelect(result.case); setCreating(false); setDescription(''); })
              .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not create the case.'))
              .finally(() => setBusy(false));
          }}>Create and use case</Button>
          <Button size="small" disabled={busy} onClick={() => setCreating(false)}>Cancel</Button>
        </Box>
      </>}
      {error && <Alert severity="warning">{error}</Alert>}
    </Stack></AccordionDetails>
  </Accordion>;
}
