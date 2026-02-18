"""
Patch to remove Streamlit dependency from data_reader imports.

When running under FastAPI, we mock out the st.cache_resource and
st.cache_data decorators so data_reader.py can be imported unchanged.
"""

import sys
import types


def _noop_decorator(*args, **kwargs):
    """No-op decorator that replaces Streamlit cache decorators."""
    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]
    def wrapper(fn):
        return fn
    return wrapper


def patch_streamlit():
    """Create a fake 'streamlit' module so data_reader.py imports cleanly."""
    if 'streamlit' in sys.modules:
        return  # Already available (e.g. in mixed environment)

    st = types.ModuleType('streamlit')
    st.cache_resource = _noop_decorator
    st.cache_data = _noop_decorator
    st.spinner = _noop_decorator
    st.empty = lambda: type('Empty', (), {'markdown': lambda *a, **k: None, 'empty': lambda: None})()
    st.sidebar = type('Sidebar', (), {
        'error': lambda *a, **k: None,
        'warning': lambda *a, **k: None,
    })()
    sys.modules['streamlit'] = st
