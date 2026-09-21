import copy
from pathlib import Path
import sys
import unittest
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
server.plot_runtime.get('plotting')
from peptide_export import export_peptide_pdf, coverage_figures, spectrum_figures
from modification_formula import formula_mass
from peptide_mapping import analyze, digest, fragments, parse_fasta, PROTON
from types import SimpleNamespace


def spectrum_payload():
    sequence='ACDEFGHIKLMNPQRSTVWY'
    mz=np.arange(100.,1500.,10.);intensity=np.arange(len(mz),dtype=float)+1
    ions=[]
    for i in range(1,19):
        series='b' if i%2 else 'y';number=i if series=='b' else len(sequence)-i
        ions.append({'ion':f'{series}{number}+','bond':i,'observed_mz':float(mz[i*6]),
                     'theoretical_mz':float(mz[i*6]),'intensity':float(intensity[i*6]),'error_ppm':0})
    return {'kind':'spectrum','sample_name':'Synthetic', 'style':{'fig_width':6,'line_width':.8},
            'row':{'sequence':sequence,'scan_id':17,'evidence':'msms','time':1.,'charge':2,'precursor_mz':500.,'modifications':[],'fragments':ions},
            'spectrum':{'scan_id':17,'mz':mz.tolist(),'intensities':intensity.tolist()}}


class PeptideExportTests(unittest.TestCase):
    def test_unconfirmed_precursor_uses_dotted_blue_and_has_no_old_footer(self):
        chain={'id':'A','sequence':'PEPTIDER','positions':[], 'spans':[
            {'start':1,'end':8,'evidence':'msms','ms1_supported':False},
            {'start':1,'end':8,'evidence':'msms','ms1_supported':True},
            {'start':1,'end':8,'evidence':'ms1'}]}
        fig=next(coverage_figures({'chains':[chain]}))
        styles={line.get_linestyle() for line in fig.artists}
        self.assertTrue({':','-','--'} <= styles)
        self.assertFalse(any('Shared peptides' in t.get_text() or 'validated identifications' in t.get_text() for t in fig.texts))

    def test_spectrum_keeps_exact_measured_sticks_ion_labels_and_deconvolution_fonts(self):
        payload=spectrum_payload();before=copy.deepcopy(payload)
        pages=list(spectrum_figures(payload));self.assertEqual(len(pages),3)
        labels=[text.get_text() for fig in pages for ax in fig.axes for text in ax.texts]
        for ion in payload['row']['fragments']:
            self.assertTrue(any(f"{ion['observed_mz']:.5f}" in label for label in labels))
        ax=pages[0].axes[0]
        segments=ax.collections[0].get_segments()
        np.testing.assert_array_equal([s[0,0] for s in segments],payload['spectrum']['mz'])
        np.testing.assert_array_equal([s[1,1] for s in segments],payload['spectrum']['intensities'])
        self.assertEqual(ax.xaxis.label.get_fontsize(),8)
        self.assertEqual(ax.get_xticklabels()[0].get_fontsize(),7)
        existing=server.plotting.create_deconvolution_mass_spectrum_figure('x',payload['spectrum'],style=payload['style'])
        self.assertAlmostEqual(ax.get_position().height*pages[0].get_size_inches()[1],existing.axes[0].get_position().height*existing.get_size_inches()[1])
        self.assertEqual(ax.xaxis.label.get_fontfamily(),existing.axes[0].xaxis.label.get_fontfamily())
        self.assertEqual(payload,before)
        server.plt.close(existing)

    def test_pdf_endpoint_returns_vector_pdf_and_rejects_mismatched_or_invented_peaks(self):
        payload=spectrum_payload()
        response=server.peptide_export_pdf(payload)
        self.assertEqual(response.media_type,'application/pdf');self.assertTrue(response.body.startswith(b'%PDF'))
        self.assertNotIn(b'/Subtype /Image',response.body)
        for field,value in [('scan_id',999)]:
            bad=copy.deepcopy(payload);bad['spectrum'][field]=value
            with self.assertRaises(server.HTTPException):server.peptide_export_pdf(bad)
        bad=copy.deepcopy(payload);bad['row']['fragments'][0]['observed_mz']=1.234
        with self.assertRaises(server.HTTPException):server.peptide_export_pdf(bad)

    def test_coverage_paginates_dense_lanes_without_discarding_evidence_or_tail(self):
        chain={'id':'A','sequence':'K'*125,'name':'Reference','ms_percent':100,'msms_percent':80,
               'positions':list(range(1,101)), 'spans':[{'start':1,'end':125,'evidence':'ms1' if i%2 else 'msms'} for i in range(130)]}
        payload={'kind':'map','chains':[chain]};before=copy.deepcopy(payload)
        pages=list(coverage_figures(payload));self.assertGreater(len(pages),3)
        lines=[line for fig in pages for line in fig.artists if len(set(line.get_xdata()))>1]
        self.assertEqual(len(lines),130*4)  # Four 40-residue blocks, including the last five residues.
        texts=[text.get_text() for fig in pages for text in fig.texts]
        self.assertTrue(any('121-125' in text for text in texts))
        self.assertEqual(sum(text=='Peptide coverage map' for text in texts),len(pages))
        self.assertEqual(payload,before)
        self.assertTrue(export_peptide_pdf({'kind':'map','chains':[dict(chain,spans=[])]}).startswith(b'%PDF'))

    def test_ms_only_export_does_not_invent_fragments(self):
        payload=spectrum_payload();payload['row']['evidence']='ms1';payload['row']['fragments']=[]
        pages=list(spectrum_figures(payload));self.assertEqual(len(pages),1)
        self.assertEqual(len(pages[0].axes[0].texts),0)

    def test_long_sequence_dual_charge_cuts_do_not_overlap_position_numbers(self):
        payload=spectrum_payload()
        payload['row']['sequence']='K'*70
        payload['row']['fragments']=[
            {'ion':f'b{bond}'+('+' if charge==1 else '^2+'), 'bond':bond,
             'observed_mz':payload['spectrum']['mz'][bond+charge]}
            for bond in [1,14,15,69] for charge in [1,2]]
        payload['sample_name']='Long synthetic name '*12
        fig=next(spectrum_figures(payload));fig.canvas.draw()
        renderer=fig.canvas.get_renderer()
        positions=[text for text in fig.texts if text.get_text().isdigit()]
        labels=[text for text in fig.texts if (text.get_gid() or '').startswith('peptide-ion-b-')]
        self.assertEqual(len(positions),70)
        self.assertEqual(len(labels),8)
        for label in labels:
            box=label.get_window_extent(renderer)
            self.assertTrue(fig.bbox.contains(box.x0,box.y0))
            self.assertTrue(fig.bbox.contains(box.x1,box.y1))
            self.assertFalse(any(box.overlaps(pos.get_window_extent(renderer)) for pos in positions))

    def test_pdf_ladder_matches_app_colours_directions_subscripts_and_superscripts(self):
        payload=spectrum_payload();payload['row']['modifications']=[{'residue':9,'delta':114.04292747,'kind':'gg'}]
        pages=list(spectrum_figures(payload))
        for fig in pages:
            texts={text.get_gid():text for text in fig.texts if text.get_gid()}
            lines={line.get_gid():line for line in fig.artists}
            for ion in payload['row']['fragments']:
                series=ion['ion'][0];number=int(ion['ion'][1:-1]);bond=ion['bond']
                label=texts[f'peptide-ion-{series}-{number}-1'];residue=texts[f'peptide-residue-{bond}']
                self.assertIn(f'_{{{number}}}^{{+1}}',label.get_text())
                self.assertEqual(label.get_color(),'#3750aa' if series=='b' else '#e52a2a')
                self.assertEqual(label.get_position()[1]<residue.get_position()[1],series=='b')
                line=lines[f'peptide-cut-{series}-{bond}'];xs,ys=line.get_data()
                self.assertEqual(xs[0],xs[1])
                self.assertEqual(xs[2]<xs[1],series=='b')
                self.assertEqual(ys[2]<ys[1],series=='b')
            self.assertEqual(texts['peptide-residue-9'].get_color(),'#c52b2b')
            self.assertEqual(texts['peptide-modification-9'].get_text(),'*')
            self.assertFalse(any('Candidate assignments, not validated identifications' in text.get_text() for text in fig.texts))
            self.assertFalse(any('Shared peptides do not identify a chain.' in text.get_text() for text in fig.texts))

    def test_same_cut_charge_labels_have_extra_vertical_space_without_moving_cut_marks(self):
        payload=spectrum_payload()
        payload['row']['fragments'] += [{**ion,'ion':ion['ion'][:-1]+'^2+'} for ion in payload['row']['fragments']]
        fig=next(spectrum_figures(payload));fig.canvas.draw()
        texts={t.get_gid():t for t in fig.texts if t.get_gid()}
        for ion in payload['row']['fragments'][:18]:
            series=ion['ion'][0];number=int(ion['ion'][1:-1])
            first=texts[f'peptide-ion-{series}-{number}-1'];second=texts[f'peptide-ion-{series}-{number}-2']
            distance=abs(first.get_position()[1]-second.get_position()[1])*fig.get_size_inches()[1]*72
            self.assertAlmostEqual(distance,(26 if series=='b' else 25)*.45)
            self.assertFalse(first.get_window_extent().overlaps(second.get_window_extent()))

    def test_blue_ladder_label_boxes_do_not_touch_cut_lines(self):
        payload=spectrum_payload()
        payload['row']['fragments'] += [{**ion,'ion':ion['ion'][:-1]+'^2+'} for ion in payload['row']['fragments'] if ion['ion'].startswith('b')]
        for fig in spectrum_figures(payload):
            fig.canvas.draw();renderer=fig.canvas.get_renderer()
            lines={line.get_gid():line for line in fig.artists}
            for label in fig.texts:
                if not (label.get_gid() or '').startswith('peptide-ion-b-'): continue
                bond=label.get_gid().split('-')[3]
                line=lines[f'peptide-cut-b-{bond}']
                line_points=line.get_transform().transform(np.column_stack(line.get_data()))
                self.assertLess(label.get_window_extent(renderer).y1, line_points[:,1].min()-1)

    def test_coverage_modifications_keep_red_residues_and_ambiguous_site_marks(self):
        chain={'id':'A','sequence':'PEPTIDER','percent':100,'positions':list(range(1,9)),
               'modification_sites':[{'position':3,'ambiguous':False},{'position':5,'ambiguous':True}]}
        fig=next(coverage_figures({'chains':[chain]}))
        texts={text.get_gid():text for text in fig.texts if text.get_gid()}
        self.assertEqual(texts['coverage-residue-3'].get_color(),'#c52b2b')
        self.assertEqual(texts['coverage-residue-5'].get_color(),'#c52b2b')
        self.assertEqual(texts['coverage-residue-4'].get_color(),'#222222')
        self.assertTrue(any(line.get_gid()=='coverage-site-unresolved-5' for line in fig.artists))
        for bad in [None,[{'position':0,'ambiguous':False}],[{'position':True,'ambiguous':False}],
                    [{'position':9,'ambiguous':False}],[{'position':3,'ambiguous':'false'}],
                    [{'position':3,'ambiguous':False}]*2]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):
                list(coverage_figures({'chains':[{**chain,'modification_sites':bad}]}))


class FormulaAndSiteTests(unittest.TestCase):
    def test_composition_matches_known_shifts_and_handles_net_losses(self):
        self.assertAlmostEqual(formula_mass('C2H2O')['delta'],42.01056468403,places=8)
        self.assertAlmostEqual(formula_mass('C4H6N2O2')['delta'],114.04292747,places=7)
        self.assertAlmostEqual(formula_mass('H-2')['delta'],-2.01565006446,places=8)
        self.assertEqual(formula_mass(' CHO ')['composition'],{'C':1,'H':1,'O':1})
        self.assertAlmostEqual(formula_mass('H-2O-1')['delta'],-18.01056468403,places=8)

    def test_invalid_or_unsupported_formula_is_not_silently_treated_as_zero(self):
        for value in ['',None,'C2H2O+','13C2','C(2)','H-','Xx2','H100000','H0','C1C-1']:
            with self.subTest(value=value),self.assertRaises(ValueError):formula_mass(value)
        with self.assertRaises(server.HTTPException):server.peptide_modification_mass({'formula':'?'})

    def test_backend_recalculates_formula_instead_of_trusting_stale_preview_mass(self):
        from unittest.mock import patch
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,1):SimpleNamespace(metadata=[],scans=[])})
        mod={'chain':'A','position':6,'kind':'custom','formula':'C2H2O','delta':999.}
        import peptide_mapping
        with patch.object(peptide_mapping,'digest_with_site_search',wraps=peptide_mapping.digest_with_site_search) as fn:
            analyze(sample,{'fasta':'AAAAAK','modifications':[mod]})
        self.assertAlmostEqual(fn.call_args.args[2][0]['delta'],42.01056468403)
        self.assertEqual(mod['delta'],999.)

    def test_unknown_site_requires_fragments_that_carry_the_modification(self):
        sequence='AAAAAKAAAAAR';mod={'chain':'A','position':6,'kind':'gg','delta':114.04292747,'block_cleavage':True}
        peptide=digest(parse_fasta(sequence),0,[mod])[0][0]
        ions=[(mass,100.) for label,mass,bond in fragments(peptide['residue_masses'],1)
              if (label.startswith('b') and bond<6) or (label.startswith('y') and bond>=6)]
        channel=SimpleNamespace(metadata=[{'scan_id':3,'time':1.,'precursor_mz':peptide['mass']+PROTON}],scans=[np.array(sorted(ions))])
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):channel})
        result=analyze(sample,{'fasta':sequence,'modifications':[{'chain':'*','kind':'gg','search_all':True}]})
        self.assertFalse(any(row['site_search'] for row in result['matches']))


if __name__=='__main__':unittest.main()
