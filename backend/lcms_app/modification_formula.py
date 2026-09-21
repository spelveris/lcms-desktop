"""Net elemental changes, not whole-residue formulas or charged m/z values."""
import re

# Neutral monoisotopic atomic masses (NIST isotope compositions).
# https://physics.nist.gov/PhysRefData/Compositions/index.html
ATOMIC_MASSES = {'H':1.00782503223, 'C':12.0, 'N':14.00307400443,
                'O':15.99491461957, 'P':30.97376199842, 'S':31.9720711744,
                'F':18.99840316273, 'Cl':34.968852682, 'Br':78.9183376,
                'I':126.9044719, 'Si':27.97692653465, 'Se':79.9165218}


def formula_mass(formula):
    if not isinstance(formula, str) or not 0 < len(formula) <= 128:
        raise ValueError('Enter a net elemental change, for example C2H2O or H-2')
    text = re.sub(r'\s+', '', formula)
    atoms, offset = {}, 0
    for match in re.finditer(r'([A-Z][a-z]?)(-?\d*)', text):
        if match.start() != offset:
            raise ValueError('Use elemental counts such as C2H2O or H-2; no charges, brackets or isotope labels')
        symbol, count = match.groups()
        if symbol not in ATOMIC_MASSES:
            raise ValueError(f'Unsupported element {symbol}; supported: {", ".join(ATOMIC_MASSES)}')
        if count == '-': raise ValueError('A negative atom count needs a number, for example H-2')
        count = int(count or '1')
        if abs(count) > 1000: raise ValueError('Atom counts must be between -1000 and 1000')
        atoms[symbol] = atoms.get(symbol, 0) + count
        offset = match.end()
    if not atoms or offset != len(text): raise ValueError('Invalid net elemental formula')
    mass = sum(ATOMIC_MASSES[symbol]*count for symbol, count in atoms.items())
    if not 0 < abs(mass) <= 2000: raise ValueError('Net modification mass must be nonzero and within +/-2000 Da')
    return {'formula':text, 'composition':atoms, 'delta':mass}
