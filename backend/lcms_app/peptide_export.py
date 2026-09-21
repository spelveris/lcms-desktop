"""Vector peptide PDFs using the existing Deconvolution font/export conventions."""
import io
import math
import re
import textwrap
from threading import Lock
import numpy as np
from matplotlib.figure import Figure
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.backends.backend_pdf import PdfPages
from plotting import _get_deconvolution_panel_dimensions, _apply_safe_scientific_y_format

EXPORT_LOCK = Lock()
BLUE, RED, GREEN = '#3750aa', '#e52a2a', '#328552'
# Match the on-screen SVG ladder's 36px cells, 216px height and angled cuts.
# Scale its geometry to print points; keep spectrum axes at Deconvolution sizes.
CLEAVAGE_SCALE = .45
CLEAVAGE_CELL = 36
CLEAVAGE_ROW_HEIGHT = (216+20)*CLEAVAGE_SCALE


def _text(value):
    return str(value).replace('$', r'\$').replace('\n', ' ')


def _style(payload):
    style = payload.get('style') or {}
    if not isinstance(style, dict): raise ValueError('Invalid PDF style')
    width = float(style.get('fig_width', 6))
    line = float(style.get('line_width', .8))
    if not math.isfinite(width) or not math.isfinite(line): raise ValueError('Invalid PDF style')
    return max(6., min(16., width)), max(.5, min(3., line)), style


def _page(width, height, title, subtitle):
    fig = Figure(figsize=(width, height)); FigureCanvasAgg(fig)
    fig.text(.065, 1-22/(height*72), title, fontsize=9, weight='bold')
    lines = textwrap.wrap(_text(subtitle), max(40, int(width*15))) or ['']
    fig.text(.065, 1-36/(height*72), '\n'.join(lines), fontsize=7, va='top')
    return fig, height*72-48-len(lines)*9


def _footer(fig, text):
    fig.text(.065, .025, text, fontsize=7, color='#555555')


def _pack(spans, start, end):
    visible = sorted([dict(s, lo=max(s['start'], start), hi=min(s['end'], end))
                      for s in spans if s['start'] <= end and s['end'] >= start], key=lambda s:(s['lo'],s['hi']))
    stops = []
    for span in visible:
        lane = next((i for i, stop in enumerate(stops) if stop < span['lo']), len(stops))
        if lane == len(stops): stops.append(span['hi'])
        else: stops[lane] = span['hi']
        span['lane'] = lane
    return visible, len(stops)


def coverage_figures(payload):
    width, _, _ = _style(payload); height = 8.3
    chains = payload.get('chains')
    if not isinstance(chains, list) or not 1 <= len(chains) <= 26: raise ValueError('Export requires 1-26 reference chains')
    if any(not isinstance(c,dict) or not isinstance(c.get('sequence'),str) for c in chains): raise ValueError('Invalid reference chain')
    if sum(len(c['sequence']) for c in chains) > 10000: raise ValueError('Reference is too long')
    for chain in chains:
        seq = chain.get('sequence', '')
        if not re.fullmatch('[ACDEFGHIKLMNPQRSTVWY]+', seq): raise ValueError('Invalid reference sequence')
        spans = chain.get('spans', [])
        if not isinstance(spans, list) or len(spans) > 20000: raise ValueError('Too many coverage spans')
        for s in spans:
            if not isinstance(s,dict): raise ValueError('Invalid coverage span')
            if not isinstance(s.get('start'), int) or not isinstance(s.get('end'), int) or not 1 <= s['start'] <= s['end'] <= len(seq) or s.get('evidence') not in {'ms1','msms'}:
                raise ValueError('Invalid coverage span')
        modification_sites = chain.get('modification_sites', [])
        if not isinstance(modification_sites, list) or len(modification_sites) > len(seq):
            raise ValueError('Invalid modification sites')
        modified = {}
        for site in modification_sites:
            if not isinstance(site, dict) or type(site.get('position')) is not int or not 1 <= site['position'] <= len(seq) or type(site.get('ambiguous')) is not bool:
                raise ValueError('Invalid modification site')
            if site['position'] in modified: raise ValueError('Duplicate modification site')
            modified[site['position']] = site['ambiguous']
        ms = float(chain.get('ms_percent', chain.get('percent', 0)))
        msms = float(chain.get('msms_percent', chain.get('percent', 0)))
        if not all(math.isfinite(p) and 0 <= p <= 100 for p in [ms, msms]): raise ValueError('Invalid coverage percentage')
        subtitle = f"{payload.get('sample_name', 'Sample')} | Chain {chain.get('id','')} - {chain.get('name','')} | MS {ms:.1f}% | MS/MS {msms:.1f}%"
        def new_page():
            fig, top = _page(width, height, 'Peptide coverage map', subtitle)
            fig.text(.065, (top-3)/(height*72), 'Blue solid: MS/MS    Green dashed: tentative MS-only', fontsize=7)
            _footer(fig, 'MS includes MS/MS; percentages are not additive. Candidates, not validated identifications.')
            if modified:
                fig.text(.065, (top-15)/(height*72), 'Red residue: MS/MS modification candidate; dotted: unresolved site', fontsize=7)
            return fig, top-(34 if modified else 22)
        fig, y = new_page()
        columns = max(10, int((width*72-60)/8)//10*10)
        cell = (width*72-60)/columns; x0 = 30
        covered = set(chain.get('positions', []))
        for offset in range(0, len(seq), columns):
            end = min(len(seq), offset+columns)
            visible, lanes = _pack(spans, offset+1, end)
            lane_start = 0
            while True:
                if y < 95:
                    yield fig; fig, y = new_page()
                count = max(1, min(max(1, lanes-lane_start), int((y-70)/6)))
                fig.text(x0/(width*72), y/(height*72), f'{offset+1}-{end}' + (f' (evidence lanes {lane_start+1}-{lane_start+count})' if lane_start or lanes>count else ''), fontsize=7, color='#555555')
                y -= 15
                for index, aa in enumerate(seq[offset:end]):
                    position=offset+index+1
                    fig.text((x0+(index+.5)*cell)/(width*72), y/(height*72), aa, ha='center', fontsize=8,
                             color='#c52b2b' if position in modified else '#222222', weight='bold' if position in modified else 'normal',
                             gid=f'coverage-residue-{position}',
                             bbox=dict(facecolor='#cde7fa' if position in covered else '#f2f2f2', edgecolor='none', pad=.5))
                    if modified.get(position, False):
                        from matplotlib.lines import Line2D
                        xx=np.array([x0+(index+.15)*cell,x0+(index+.85)*cell])/(width*72)
                        fig.add_artist(Line2D(xx,[(y-2)/(height*72)]*2,transform=fig.transFigure,color='#c52b2b',linestyle=':',linewidth=.8,gid=f'coverage-site-unresolved-{position}'))
                for span in visible:
                    if not lane_start <= span['lane'] < lane_start+count: continue
                    xx = [x0+(span['lo']-offset-1)*cell+1, x0+(span['hi']-offset)*cell-1]
                    yy = y-6-(span['lane']-lane_start)*6
                    colour = GREEN if span['evidence']=='ms1' else '#4e9dce'
                    from matplotlib.lines import Line2D
                    fig.add_artist(Line2D(np.array(xx)/(width*72), [yy/(height*72)]*2, transform=fig.transFigure,
                                          color=colour, linewidth=.8, linestyle='--' if span['evidence']=='ms1' else '-'))
                    for x, endpoint in [(xx[0], span['start'] >= offset+1), (xx[1], span['end'] <= end)]:
                        if endpoint:
                            fig.add_artist(Line2D([x/(width*72)]*2, np.array([yy,yy+2])/(height*72), transform=fig.transFigure, color=colour, linewidth=.6))
                y -= 6*count+20; lane_start += count
                if lane_start >= lanes: break
                yield fig; fig, y = new_page()
        yield fig


def _spectrum_data(payload):
    row, spectrum = payload.get('row'), payload.get('spectrum')
    if not isinstance(row, dict) or not isinstance(spectrum, dict): raise ValueError('Select a measured peptide spectrum first')
    if not re.fullmatch('[ACDEFGHIKLMNPQRSTVWY]{1,70}', row.get('sequence', '')): raise ValueError('Invalid peptide sequence')
    mz, intensity = np.asarray(spectrum.get('mz'), dtype=float), np.asarray(spectrum.get('intensities'), dtype=float)
    if mz.ndim != 1 or intensity.shape != mz.shape or not 1 <= len(mz) <= 200000 or not np.isfinite(mz).all() or not np.isfinite(intensity).all() or np.any(mz <= 0) or np.any(intensity < 0):
        raise ValueError('Invalid measured spectrum arrays')
    if row.get('scan_id') != spectrum.get('scan_id'): raise ValueError('Selected peptide and measured scan do not match')
    if row.get('evidence') == 'ms1': return row, mz, intensity, []
    ions = []
    if len(row.get('fragments', [])) > 300: raise ValueError('Too many fragment labels')
    for ion in row.get('fragments', []):
        label = re.fullmatch(r'([by])(\d+)(?:\^(\d+)\+|\+)', str(ion.get('ion','')))
        if not label: raise ValueError('Invalid fragment-ion label')
        series, number, charge = label[1], int(label[2]), int(label[3] or 1)
        bond = number if series=='b' else len(row['sequence'])-number
        if not 0 < bond < len(row['sequence']) or ion.get('bond') != bond or charge not in {1,2}: raise ValueError('Invalid fragment cut or charge')
        observed = float(ion['observed_mz'])
        indices = np.flatnonzero(np.isclose(mz, observed, rtol=0, atol=1e-8))
        if not len(indices): raise ValueError('A labelled fragment is missing from the measured spectrum')
        ions.append({**ion, 'series':series, 'number':number, 'charge':charge,
                     'observed_mz':observed, 'intensity':float(intensity[indices[0]])})
    return row, mz, intensity, sorted(ions, key=lambda i:i['observed_mz'])


def _cleavage_columns(width):
    return max(8, int((width*72-70)/(CLEAVAGE_CELL*CLEAVAGE_SCALE)))


def _cleavage_map(fig, row, ions, top, width, height):
    sequence = row['sequence']; columns = _cleavage_columns(width); scale = CLEAVAGE_SCALE
    modifications = {m['residue']:m for m in row.get('modifications', [])}
    for offset in range(0, len(sequence), columns):
        y = top-(offset//columns)*CLEAVAGE_ROW_HEIGHT
        for j, aa in enumerate(sequence[offset:offset+columns]):
            pos=offset+j+1; x=35+(26+j*CLEAVAGE_CELL)*scale
            fig.text(x/(width*72), y/(height*72), aa, fontsize=30*scale, fontfamily='monospace',
                     ha='center', color='#c52b2b' if pos in modifications else '#222222', gid=f'peptide-residue-{pos}')
            if pos in modifications:
                fig.text((x+14*scale)/(width*72), (y+24*scale)/(height*72), '*',
                         fontsize=15*scale, fontfamily='monospace', color='#c52b2b', gid=f'peptide-modification-{pos}')
            fig.text(x/(width*72), (y-108*scale)/(height*72), str(pos), fontsize=5.5,
                     fontfamily='monospace', ha='center', color='#666666', gid=f'peptide-position-{pos}')
            for series, direction in [('b',-1),('y',1)]:
                at_cut = sorted([ion for ion in ions if ion['bond']==pos and ion['series']==series],key=lambda ion:ion['charge'])
                if not at_cut: continue
                from matplotlib.lines import Line2D
                cut=x+(CLEAVAGE_CELL/2+direction*2)*scale
                svg_y=np.array([88,110,122] if series=='b' else [82,60,48])
                fig.add_artist(Line2D(np.array([cut,cut,cut+direction*12*scale])/(width*72),
                                     (y+(96-svg_y)*scale)/(height*72), transform=fig.transFigure,
                                     color=BLUE if series=='b' else RED, linewidth=1.8*scale, gid=f'peptide-cut-{series}-{pos}'))
                for idx, ion in enumerate(at_cut):
                    svg_label_y=153+idx*20 if series=='b' else 39-idx*19
                    label=rf"$\mathregular{{{series}}}_{{{ion['number']}}}^{{+{ion['charge']}}}$"
                    fig.text((cut+direction*12*scale)/(width*72), (y+(96-svg_label_y)*scale)/(height*72),
                             label, fontsize=15*scale, fontfamily='monospace', color=BLUE if series=='b' else RED,
                             ha='center', gid=f"peptide-ion-{series}-{ion['number']}-{ion['charge']}")


def spectrum_figures(payload):
    row, mz, intensity, ions = _spectrum_data(payload)
    width, linewidth, style = _style(payload)
    _, panel_height = _get_deconvolution_panel_dimensions(float(style.get('fig_width',6)))
    axis_height = panel_height*.65  # Same physical axis height and 8/7 pt fonts as Deconvolution.
    columns=_cleavage_columns(width); seq_rows=math.ceil(len(row['sequence'])/columns)
    modifications=[]
    for mod in row.get('modifications',[]):
        pos=int(mod['residue'])
        if not 1 <= pos <= len(row['sequence']): raise ValueError('Invalid modified residue')
        sites=' / '.join(f"{loc['chain']}:{row['sequence'][pos-1]}{loc['start']+pos-1}" for loc in row.get('locations',[]))
        modifications.append(f"* {row['sequence'][pos-1]}{pos} ({sites or 'peptide position'}): {float(mod['delta']):+.8f} Da" + (f"; net {mod['formula']}" if mod.get('formula') else ''))
        if mod.get('kind')=='gg':modifications.append('GGisoK: GG C-terminal carbonyl attached to lysine epsilon-N. Donor chain is unresolved by the remnant.')
    mod_lines=[line for text in modifications for line in textwrap.wrap(_text(text),int(width*16))]
    mod_height=(len(mod_lines)*9+10) if mod_lines else 0
    height = max(5.2, axis_height+3.1+seq_rows*CLEAVAGE_ROW_HEIGHT/72)+mod_height/72
    strongest=sorted(sorted(ions,key=lambda i:i['intensity'],reverse=True)[:12],key=lambda i:i['observed_mz'])
    panels=[(None, strongest)]
    if len(ions)>12:
        for start in range(0,len(ions),12):
            group=ions[start:start+12];lo,hi=group[0]['observed_mz'],group[-1]['observed_mz'];pad=max(2.,(hi-lo)*.08)
            panels.append(((max(0,lo-pad),hi+pad),group))
    for index,(limits, labels) in enumerate(panels):
        title='Peptide MS-only spectrum' if row.get('evidence')=='ms1' else 'Peptide MS/MS spectrum'
        if index:title+=f' - labelled detail {index}'
        subtitle=f"{payload.get('sample_name','Sample')} | Scan {row['scan_id']} | {float(row.get('time',0)):.4f} min | Precursor m/z {float(row['precursor_mz']):.5f} | inferred +{row['charge']}"
        extra_header=max(0,len(textwrap.wrap(_text(subtitle),max(40,int(width*15))))-2)*9/72
        page_height=height+extra_header
        fig, top=_page(width,page_height,title,subtitle)
        axis_bottom=page_height-axis_height-1.6-extra_header
        ax=fig.add_axes([.10,axis_bottom/page_height,.86,axis_height/page_height])
        ax.vlines(mz,0,intensity,color='#333333',linewidth=linewidth*.6)
        for ion in ions:ax.vlines(ion['observed_mz'],0,ion['intensity'],color=BLUE if ion['series']=='b' else RED,linewidth=linewidth)
        if limits:ax.set_xlim(*limits)
        else:ax.set_xlim(max(0,float(mz.min())-10),float(mz.max())+10)
        in_view=(mz>=ax.get_xlim()[0])&(mz<=ax.get_xlim()[1])
        maximum=max(1.,float(intensity[in_view].max()) if in_view.any() else 1.)
        ax.set_ylim(0,maximum*1.05)
        ax.set_xlabel('m/z',fontsize=8);ax.set_ylabel('Intensity',fontsize=8);ax.tick_params(labelsize=7)
        ax.spines['top'].set_visible(False);ax.spines['right'].set_visible(False)
        if style.get('show_grid'):ax.grid(True,alpha=.3)
        _apply_safe_scientific_y_format(ax,scilimits=(0,0))
        for k,ion in enumerate(labels):
            ax.annotate(f"{ion['series']}{ion['number']} +{ion['charge']}\n{ion['observed_mz']:.5f}",
                        xy=(ion['observed_mz'],ion['intensity']),xytext=((k+.5)/max(1,len(labels)),1.08+(k%2)*.27),
                        textcoords='axes fraction',ha='center',va='bottom',fontsize=7,
                        color=BLUE if ion['series']=='b' else RED,
                        arrowprops=dict(arrowstyle='-',linewidth=.45,color='#777777'),annotation_clip=False)
        note='Measured m/z labels; blue b ions / red y ions. * = modified residue.'
        if len(ions)>12 and index==0:note='Strongest 12 labelled here; all matched ions labelled on detail pages. '+note
        if row.get('evidence')=='ms1':note='MS-only mass hypothesis: no b/y evidence or site localization.'
        fig.text(.065,(axis_bottom*72-38)/(page_height*72),'\n'.join(textwrap.wrap(note,int(width*16))),fontsize=7,va='top')
        _cleavage_map(fig,row,ions,axis_bottom*72-112,width,page_height)
        if mod_lines:fig.text(.065,(35+mod_height)/(page_height*72),'\n'.join(mod_lines),fontsize=7,va='top')
        _footer(fig,'Shared peptides do not identify a chain.')
        yield fig


def export_peptide_pdf(payload):
    kind=payload.get('kind')
    if kind not in {'map','spectrum'}: raise ValueError('Choose map or spectrum PDF')
    with EXPORT_LOCK:
        output=io.BytesIO()
        with PdfPages(output, metadata={'Title':'CATrupole peptide '+kind,'Author':''}) as pdf:
            pages=coverage_figures(payload) if kind=='map' else spectrum_figures(payload)
            for index,fig in enumerate(pages,1):
                if index>500: raise ValueError('Too many PDF pages; narrow the reference')
                fig.text(.965,.025,str(index),ha='right',fontsize=7,color='#555555')
                try:pdf.savefig(fig,transparent=True)
                finally:fig.clear()
        return output.getvalue()
