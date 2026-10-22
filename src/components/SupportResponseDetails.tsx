import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import useMediaQuery from '@mui/material/useMediaQuery';
import { normalizeResponseDetails, type ChatResponseDetails, type SupportCard, type SupportOutcome } from '../services/supportContracts';

export const SUPPORT_OUTCOMES: Record<SupportOutcome, string> = {
  not_attempted: 'Not attempted', helped: 'Helped', no_change: 'No change', worse: 'Worse',
};

function SupportCheck({ card, onOutcome, disabled }: {
  card: SupportCard;
  onOutcome?: (card: SupportCard, outcome: SupportOutcome, observed: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [outcome, setOutcome] = useState<SupportOutcome>('not_attempted');
  const [observed, setObserved] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <Accordion disableGutters variant="outlined" sx={{ my: 1 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography sx={{ fontWeight: 600 }}>{card.check}</Typography></AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.25}>
          <Typography variant="body2">{card.explanation}</Typography>
          <Typography variant="body2"><strong>Expected result: </strong>{card.expected_result}</Typography>
          {card.command && <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', p: 1.5, bgcolor: 'action.hover' }}>{card.command}</Box>}
          {card.evidence_ids.length > 0 && <Typography variant="caption">Evidence: {card.evidence_ids.join(', ')}</Typography>}
          {onOutcome && <>
            <TextField select size="small" label="Result of this check" value={outcome} onChange={event => setOutcome(event.target.value as SupportOutcome)} disabled={saving || disabled}>
              {Object.entries(SUPPORT_OUTCOMES).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
            </TextField>
            <TextField size="small" label="What happened?" multiline minRows={2} value={observed} onChange={event => setObserved(event.target.value)} slotProps={{ htmlInput: { maxLength: 2000 } }} disabled={saving || disabled} />
            <Button size="small" disabled={saving || disabled} onClick={() => {
              setSaving(true); setMessage('');
              void onOutcome(card, outcome, observed).then(() => setMessage('Result saved to your support case.'))
                .catch(error => setMessage(error instanceof Error ? error.message : 'Could not save the result.'))
                .finally(() => setSaving(false));
            }}>Save result to case</Button>
          </>}
          {message && <Typography role="status" variant="body2">{message}</Typography>}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function SupportResponseDetails({ details: rawDetails, onOutcome, disabled }: {
  details: ChatResponseDetails;
  onOutcome?: (card: SupportCard, outcome: SupportOutcome, observed: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const mobile = useMediaQuery('(max-width:600px)');
  const details = normalizeResponseDetails(rawDetails);
  if (!details) return null;
  return <Box sx={{ my: 1 }}>
    {details.cards?.map(card => <SupportCheck key={card.id} card={card} onOutcome={onOutcome} disabled={disabled} />)}
    <Button size="small" onClick={() => setOpen(true)} aria-haspopup="dialog">View evidence and context</Button>
    <Drawer anchor={mobile ? 'bottom' : 'right'} open={open} onClose={() => setOpen(false)}
      slotProps={{ paper: { role: 'dialog', 'aria-label': 'Evidence and context', sx: { boxSizing: 'border-box', width: mobile ? '100%' : 420, maxWidth: '100vw', maxHeight: mobile ? '85dvh' : '100dvh', p: 2.5 } } }}>
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography component="h2" variant="h6">Evidence and context</Typography><Button onClick={() => setOpen(false)}>Close</Button>
        </Box>
        {details.context && <Box>
          <Typography component="h3" sx={{ fontWeight: 600 }}>Context used</Typography>
          <Typography variant="body2">{details.context.mode === 'troubleshoot' ? 'Guided Windows troubleshooting' : 'Chat'}</Typography>
          {details.context.case_id && <Typography variant="body2">Support case revision {details.context.case_revision ?? 'unavailable'}</Typography>}
          <Typography variant="body2">Selected attachments: {details.context.included_attachment_ids.length}</Typography>
          <Typography variant="body2">{details.context.recovery_used ? 'Recovery included' : 'Recovery window'}: {details.context.history_items} recent messages, up to {details.context.history_item_bytes.toLocaleString()} bytes each.</Typography>
          {details.context.history_truncated && <Alert severity="info">Older or longer messages were omitted from recovery. Reviewed case facts are supplied separately.</Alert>}
        </Box>}
        <Typography component="h3" sx={{ fontWeight: 600 }}>Sources and diagnostic evidence</Typography>
        {!details.evidence?.length && <Typography variant="body2">No detailed source records were supplied for this response. Links in the answer remain available.</Typography>}
        {details.evidence?.map(evidence => <Box key={evidence.id} id={`evidence-${evidence.id}`} sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1.5 }}>
          <Typography variant="overline">{evidence.kind === 'microsoft' ? 'Microsoft documentation' : evidence.kind === 'forum' ? 'WindowsForum' : evidence.kind === 'diagnostic' ? 'Your diagnostic' : 'Web source'} · {evidence.id}</Typography>
          {evidence.url ? <Typography component="a" href={evidence.url} target="_blank" rel="noopener noreferrer" sx={{ display: 'block' }}>{evidence.title}</Typography> : <Typography sx={{ fontWeight: 600 }}>{evidence.title}</Typography>}
          {evidence.excerpt && <Typography component="blockquote" variant="body2" sx={{ mx: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{evidence.excerpt}</Typography>}
          {evidence.line_start && <Typography variant="caption" sx={{ display: 'block' }}>Submitted text, lines {evidence.line_start}–{evidence.line_end ?? evidence.line_start}</Typography>}
          {evidence.published_at && <Typography variant="caption" sx={{ display: 'block' }}>Published: {evidence.published_at}</Typography>}
          {evidence.retrieved_at && <Typography variant="caption" sx={{ display: 'block' }}>Retrieved: {evidence.retrieved_at}</Typography>}
        </Box>)}
      </Stack>
    </Drawer>
  </Box>;
}
