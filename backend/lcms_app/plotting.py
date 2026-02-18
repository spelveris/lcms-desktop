"""Plotting functions for LC-MS data visualization."""

import io
import textwrap
from typing import Optional
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.figure
from matplotlib.backends.backend_agg import FigureCanvasAgg

# Set smaller default font sizes
plt.rcParams.update({
    # Prefer Arial so exported PDFs open in Affinity with matching text style.
    # If Arial is unavailable, fall back to common sans-serif fonts.
    'font.family': 'sans-serif',
    'font.sans-serif': ['Arial', 'Liberation Sans', 'DejaVu Sans'],
    'font.size': 8,
    'axes.titlesize': 9,
    'axes.labelsize': 8,
    'xtick.labelsize': 7,
    'ytick.labelsize': 7,
    'legend.fontsize': 7,
    'figure.titlesize': 10,
    # Embed TrueType fonts in PDF for better editability in vector editors.
    'pdf.fonttype': 42,
    'ps.fonttype': 42
})

import config
from data_reader import SampleData
from analysis import smooth_data, extract_eic


def _shift_sci_offset_left(ax: plt.Axes, x: float = -0.08) -> None:
    """Move scientific-notation offset text slightly left of the y-axis spine."""
    try:
        offset = ax.yaxis.get_offset_text()
        offset.set_x(x)
        offset.set_ha('left')
    except Exception:
        pass


def create_single_panel(
    ax: plt.Axes,
    times: np.ndarray,
    data: np.ndarray,
    label: str = "",
    color: str = "#1f77b4",
    xlabel: str = "Time (min)",
    ylabel: str = "Intensity",
    smoothing: int = 0,
    line_width: float = 0.8,
    show_grid: bool = False,
    y_scale: str = "linear"
) -> None:
    """
    Create a single chromatogram panel.

    Args:
        ax: Matplotlib axes to plot on
        times: Time array
        data: Intensity array
        label: Legend label
        color: Line color
        xlabel: X-axis label
        ylabel: Y-axis label
        smoothing: Smoothing window size (0 = no smoothing)
        line_width: Width of the plot line
        show_grid: Whether to show grid
        y_scale: Y-axis scale ('linear' or 'log')
    """
    if times is None or data is None:
        ax.text(0.5, 0.5, "No data available", ha='center', va='center', transform=ax.transAxes)
        return

    plot_data = smooth_data(data, smoothing) if smoothing > 0 else data

    ax.plot(times, plot_data, color=color, label=label, linewidth=line_width)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)

    if label:
        ax.legend(loc='upper right')

    if show_grid:
        ax.grid(True, alpha=0.3)

    if y_scale == 'log':
        ax.set_yscale('log')
    else:
        ax.ticklabel_format(axis='y', style='scientific', scilimits=(-2, 3), useMathText=True)
        _shift_sci_offset_left(ax)

    ax.set_xlim(times[0], times[-1])


def create_overlay_panel(
    ax: plt.Axes,
    samples: list[tuple[str, np.ndarray, np.ndarray]],
    colors: Optional[list[str]] = None,
    xlabel: str = "Time (min)",
    ylabel: str = "Intensity",
    smoothing: int = 0,
    normalize: bool = False,
    line_width: float = 0.8,
    show_grid: bool = False,
    y_scale: str = "linear"
) -> None:
    """
    Create an overlay plot with multiple traces.

    Args:
        ax: Matplotlib axes to plot on
        samples: List of (label, times, data) tuples
        colors: Optional list of colors for each trace
        xlabel: X-axis label
        ylabel: Y-axis label
        smoothing: Smoothing window size
        normalize: Whether to normalize each trace
        line_width: Width of plot lines
        show_grid: Whether to show grid
        y_scale: Y-axis scale ('linear' or 'log')
    """
    if not samples:
        ax.text(0.5, 0.5, "No data available", ha='center', va='center', transform=ax.transAxes)
        return

    if colors is None:
        colors = config.EIC_COLORS

    x_min, x_max = float('inf'), float('-inf')

    for i, (label, times, data) in enumerate(samples):
        if times is None or data is None:
            continue

        color = colors[i % len(colors)]
        plot_data = smooth_data(data, smoothing) if smoothing > 0 else data

        if normalize and np.max(plot_data) > 0:
            plot_data = plot_data / np.max(plot_data)

        ax.plot(times, plot_data, color=color, label=label, linewidth=line_width)

        x_min = min(x_min, times[0])
        x_max = max(x_max, times[-1])

    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.legend(loc='upper right', fontsize='small')

    if x_min < x_max:
        ax.set_xlim(x_min, x_max)

    if show_grid:
        ax.grid(True, alpha=0.3)

    if y_scale == 'log':
        ax.set_yscale('log')
    else:
        ax.ticklabel_format(axis='y', style='scientific', scilimits=(-2, 3), useMathText=True)
        _shift_sci_offset_left(ax)


def create_time_progression_figure(
    samples: list[SampleData],
    labels: list[str],
    uv_wavelength: float = config.UV_WAVELENGTH,
    eic_targets: Optional[list[float]] = None,
    style: Optional[dict] = None,
    mz_window: float = config.DEFAULT_MZ_WINDOW,
    uv_smoothing: int = config.UV_SMOOTHING_WINDOW,
    eic_smoothing: int = config.EIC_SMOOTHING_WINDOW,
    metadata_method: Optional[str] = None,
    metadata_files: Optional[str] = None,
) -> matplotlib.figure.Figure:
    """
    Create a multi-panel figure comparing samples across timepoints.

    Args:
        samples: List of SampleData objects (should be 2-3)
        labels: Labels for each sample (e.g., ["Initial", "Mid", "Overnight"])
        uv_wavelength: UV wavelength to extract
        eic_targets: List of m/z values for EIC extraction
        style: Dictionary with style settings (colors, line_width, show_grid, etc.)
        mz_window: m/z window for EIC extraction
        uv_smoothing: Smoothing window for UV
        eic_smoothing: Smoothing window for EIC

    Returns:
        Matplotlib Figure object
    """
    # Default style settings
    if style is None:
        style = {}
    fig_width = style.get('fig_width', 10)
    fig_height_per_panel = style.get('fig_height_per_panel', 3)
    line_width = style.get('line_width', 0.8)
    show_grid = style.get('show_grid', False)
    y_scale = style.get('y_scale', 'linear')
    custom_colors = style.get('colors', {})
    labels_config = style.get('labels', {})

    # Get label templates
    title = labels_config.get('title_progression', 'Time Progression Analysis')
    x_label = labels_config.get('x_label', 'Time (min)')
    y_label_uv_template = labels_config.get('y_label_uv', 'UV {wavelength}nm (mAU)')
    y_label_tic = labels_config.get('y_label_tic', 'TIC Intensity')
    y_label_eic = labels_config.get('y_label_eic', 'EIC Intensity')
    panel_title_uv_template = labels_config.get('panel_title_uv', 'UV Chromatogram ({wavelength} nm)')
    panel_title_tic = labels_config.get('panel_title_tic', 'Total Ion Chromatogram (TIC)')
    panel_title_eic_template = labels_config.get('panel_title_eic', 'EIC m/z {mz} (±{window})')

    if eic_targets is None:
        eic_targets = config.DEFAULT_MZ_VALUES

    n_eics = len(eic_targets)
    n_rows = 2 + n_eics  # UV + TIC + EICs

    fig, axes = plt.subplots(n_rows, 1, figsize=(fig_width, fig_height_per_panel * n_rows))
    if n_rows == 1:
        axes = [axes]

    # Keep title close to the first panel.
    fig.suptitle(title, fontsize=10, fontweight='bold', y=0.978)

    # Render optional metadata inside the figure so exports include it.
    # Wrap long file lists and place metadata at bottom-left.
    meta_lines: list[str] = []
    metadata_font_size = 7
    left_x = 0.005
    if metadata_method:
        meta_lines.append(f"Method: {metadata_method}")
    if metadata_files:
        # Use nearly full figure width before wrapping.
        usable_width_frac = 0.995 - left_x
        usable_points = fig_width * 72.0 * usable_width_frac
        avg_char_points = metadata_font_size * 0.56
        wrap_width = max(140, int(usable_points / max(1.0, avg_char_points)))
        wrapped = textwrap.wrap(f"Files: {metadata_files}", width=wrap_width)
        if wrapped:
            meta_lines.extend(wrapped)
    metadata_line_step = 0.024
    if meta_lines:
        y = 0.008
        for line in reversed(meta_lines):
            fig.text(left_x, y, line, ha='left', va='bottom', fontsize=metadata_font_size)
            y += metadata_line_step

    # Define colors based on number of samples
    color_initial = custom_colors.get('initial', config.TIME_COLORS["initial"])
    color_mid = custom_colors.get('mid', config.TIME_COLORS["mid"])
    color_final = custom_colors.get('final', config.TIME_COLORS["final"])

    if len(samples) == 2:
        colors = [color_initial, color_final]
    elif len(samples) >= 3:
        colors = [color_initial, color_mid, color_final]
        # Extend color list for 4+ samples while preserving the first three
        # semantic colors (initial/mid/final).
        for c in config.EIC_COLORS:
            if len(colors) >= len(samples):
                break
            if c not in colors:
                colors.append(c)
        while len(colors) < len(samples):
            colors.append(config.EIC_COLORS[len(colors) % len(config.EIC_COLORS)])
    else:
        colors = [color_initial]

    # Format label templates
    y_label_uv = y_label_uv_template.format(wavelength=uv_wavelength)
    panel_title_uv = panel_title_uv_template.format(wavelength=uv_wavelength)

    # Panel 1: UV overlay
    uv_traces = []
    for i, sample in enumerate(samples):
        uv_data = sample.get_uv_at_wavelength(uv_wavelength)
        if uv_data is not None and sample.uv_times is not None:
            uv_traces.append((labels[i], sample.uv_times, uv_data))

    create_overlay_panel(
        axes[0], uv_traces, colors=colors,
        xlabel=x_label if 0 == (n_rows - 1) else "",
        ylabel=y_label_uv,
        smoothing=uv_smoothing,
        line_width=line_width,
        show_grid=show_grid,
        y_scale=y_scale
    )
    axes[0].set_title(panel_title_uv)

    # Panel 2: TIC overlay
    tic_traces = []
    for i, sample in enumerate(samples):
        if sample.tic is not None and sample.ms_times is not None:
            tic_traces.append((labels[i], sample.ms_times, sample.tic))

    create_overlay_panel(
        axes[1], tic_traces, colors=colors,
        xlabel=x_label if 1 == (n_rows - 1) else "",
        ylabel=y_label_tic,
        smoothing=eic_smoothing,
        line_width=line_width,
        show_grid=show_grid,
        y_scale=y_scale
    )
    axes[1].set_title(panel_title_tic)

    # Panels 3+: EIC for each target m/z
    for j, target_mz in enumerate(eic_targets):
        eic_traces = []
        for i, sample in enumerate(samples):
            eic = extract_eic(sample, target_mz, mz_window)
            if eic is not None and sample.ms_times is not None:
                eic_traces.append((labels[i], sample.ms_times, eic))

        panel_title_eic = panel_title_eic_template.format(mz=f"{target_mz:.2f}", window=mz_window)

        create_overlay_panel(
            axes[2 + j], eic_traces, colors=colors,
            xlabel=x_label if (2 + j) == (n_rows - 1) else "",
            ylabel=y_label_eic,
            smoothing=eic_smoothing,
            line_width=line_width,
            show_grid=show_grid,
            y_scale=y_scale
        )
        axes[2 + j].set_title(panel_title_eic)

    # Show x tick labels only on the bottom panel to avoid inter-panel overlap.
    for idx, ax in enumerate(axes):
        if idx < (n_rows - 1):
            ax.tick_params(axis='x', labelbottom=False)

    # Keep title-to-graph spacing tight while avoiding overlap.
    top_margin = 0.972
    bottom_margin = 0.025 + (metadata_line_step * len(meta_lines))
    bottom_margin = min(0.26, max(0.045, bottom_margin))

    try:
        plt.tight_layout(rect=(0.0, bottom_margin, 1.0, top_margin))
        # Keep panel-to-panel spacing stable across reruns to avoid occasional
        # title/x-label overlap on first render.
        fig.subplots_adjust(hspace=0.28)
    except Exception:
        # Avoid hard-failing on occasional text-layout parser errors on some
        # desktop environments; keep rendering with explicit spacing.
        fig.subplots_adjust(top=top_margin, bottom=bottom_margin, hspace=0.28)
    return fig


def create_single_sample_figure(
    sample: SampleData,
    uv_wavelength: float = config.UV_WAVELENGTH,
    uv_wavelengths: Optional[list[float]] = None,
    eic_targets: Optional[list[float]] = None,
    style: Optional[dict] = None,
    mz_window: float = config.DEFAULT_MZ_WINDOW,
    uv_smoothing: int = config.UV_SMOOTHING_WINDOW,
    eic_smoothing: int = config.EIC_SMOOTHING_WINDOW
) -> matplotlib.figure.Figure:
    """
    Create a multi-panel figure for a single sample.

    Args:
        sample: SampleData object
        uv_wavelength: UV wavelength to extract (deprecated, use uv_wavelengths)
        uv_wavelengths: List of UV wavelengths to extract
        eic_targets: List of m/z values for EIC extraction
        style: Dictionary with style settings
        mz_window: m/z window for EIC extraction
        uv_smoothing: Smoothing window for UV
        eic_smoothing: Smoothing window for EIC

    Returns:
        Matplotlib Figure object
    """
    # Default style settings
    if style is None:
        style = {}
    fig_width = style.get('fig_width', 10)
    fig_height_per_panel = style.get('fig_height_per_panel', 3)
    line_width = style.get('line_width', 0.8)
    show_grid = style.get('show_grid', False)
    y_scale = style.get('y_scale', 'linear')
    labels_config = style.get('labels', {})

    # Get label templates
    title_template = labels_config.get('title_single', 'Sample: {name}')
    x_label = labels_config.get('x_label', 'Time (min)')
    y_label_uv_template = labels_config.get('y_label_uv', 'UV {wavelength}nm (mAU)')
    y_label_tic = labels_config.get('y_label_tic', 'TIC Intensity')
    y_label_eic = labels_config.get('y_label_eic', 'EIC Intensity')
    panel_title_uv_template = labels_config.get('panel_title_uv', 'UV Chromatogram ({wavelength} nm)')
    panel_title_tic = labels_config.get('panel_title_tic', 'Total Ion Chromatogram (TIC)')
    panel_title_eic_template = labels_config.get('panel_title_eic', 'EIC m/z {mz} (±{window})')

    # Format label templates
    title = title_template.format(name=sample.name)

    # Support both single wavelength (legacy) and multiple wavelengths.
    # Explicit empty list means "do not include UV panels".
    if uv_wavelengths is None:
        uv_wavelengths = [uv_wavelength]

    if eic_targets is None:
        eic_targets = []

    n_uvs = len(uv_wavelengths)
    n_eics = len(eic_targets)
    n_rows = n_uvs + 1 + n_eics  # UV panels + TIC + EICs

    fig, axes = plt.subplots(n_rows, 1, figsize=(fig_width, fig_height_per_panel * n_rows))
    if n_rows == 1:
        axes = [axes]

    fig.suptitle(title, fontsize=10, fontweight='bold', y=1.005)

    # UV panels - one for each wavelength
    for i, wl in enumerate(uv_wavelengths):
        uv_data = sample.get_uv_at_wavelength(wl)
        y_label_uv = y_label_uv_template.format(wavelength=wl)
        panel_title_uv = panel_title_uv_template.format(wavelength=wl)
        create_single_panel(
            axes[i],
            sample.uv_times, uv_data,
            xlabel=x_label,
            ylabel=y_label_uv,
            color="#1f77b4",
            smoothing=uv_smoothing,
            line_width=line_width,
            show_grid=show_grid,
            y_scale=y_scale
        )
        axes[i].set_title(panel_title_uv)

    # TIC panel (after all UV panels)
    tic_idx = n_uvs
    create_single_panel(
        axes[tic_idx],
        sample.ms_times, sample.tic,
        xlabel=x_label,
        ylabel=y_label_tic,
        color="#ff7f0e",
        smoothing=eic_smoothing,
        line_width=line_width,
        show_grid=show_grid,
        y_scale=y_scale
    )
    axes[tic_idx].set_title(panel_title_tic)

    # EIC panels
    for j, target_mz in enumerate(eic_targets):
        eic = extract_eic(sample, target_mz, mz_window)
        panel_title_eic = panel_title_eic_template.format(mz=f"{target_mz:.2f}", window=mz_window)
        create_single_panel(
            axes[tic_idx + 1 + j],
            sample.ms_times, eic,
            xlabel=x_label,
            ylabel=y_label_eic,
            color=config.EIC_COLORS[j % len(config.EIC_COLORS)],
            smoothing=eic_smoothing,
            line_width=line_width,
            show_grid=show_grid,
            y_scale=y_scale
        )
        axes[tic_idx + 1 + j].set_title(panel_title_eic)

    plt.tight_layout()
    return fig


def create_eic_comparison_figure(
    sample: SampleData,
    mz_values: list[float],
    mz_window: float = config.DEFAULT_MZ_WINDOW,
    smoothing: int = config.EIC_SMOOTHING_WINDOW,
    overlay: bool = True,
    normalize: bool = True,
    selected_peaks_by_mz: Optional[dict[str, list[dict]]] = None
) -> matplotlib.figure.Figure:
    """
    Create a figure comparing multiple EICs from a single sample.

    Args:
        sample: SampleData object
        mz_values: List of m/z values to extract
        mz_window: m/z window for extraction
        smoothing: Smoothing window size
        overlay: If True, overlay all EICs; if False, separate panels

    Returns:
        Matplotlib Figure object
    """
    title_fs = 19
    panel_title_fs = 16
    axis_label_fs = 16
    tick_fs = 14
    legend_fs = 14
    peak_label_fs = 13

    if selected_peaks_by_mz is None:
        selected_peaks_by_mz = {}

    if overlay:
        fig, ax = plt.subplots(figsize=(10, 5))
        fig.suptitle(f"EIC Comparison: {sample.name}", fontsize=title_fs, fontweight='bold')
        global_y_max = 0.0

        for i, mz in enumerate(mz_values):
            eic = extract_eic(sample, mz, mz_window)
            if eic is None or sample.ms_times is None:
                continue

            times = sample.ms_times
            plot_data = smooth_data(eic, smoothing) if smoothing > 0 else eic
            if normalize and np.max(plot_data) > 0:
                plot_data = plot_data / np.max(plot_data)

            color = config.EIC_COLORS[i % len(config.EIC_COLORS)]
            ax.plot(times, plot_data, color=color, linewidth=1.0, label=f"m/z {mz:.2f}")
            global_y_max = max(global_y_max, float(np.max(plot_data)) if len(plot_data) > 0 else 0.0)

            regions = selected_peaks_by_mz.get(f"{mz:.4f}", [])
            for region in regions:
                start = float(region.get("start", times[0]))
                end = float(region.get("end", times[-1]))
                number = region.get("number")
                apex_time = float(region.get("apex_time", (start + end) / 2.0))
                if end <= start:
                    continue
                mask = (times >= start) & (times <= end)
                if not np.any(mask):
                    continue
                ax.fill_between(times[mask], 0, plot_data[mask], color="gray", alpha=0.18, linewidth=0, zorder=0)
                if number is not None:
                    local_times = times[mask]
                    local_data = plot_data[mask]
                    if len(local_data) > 0:
                        peak_idx = int(np.argmax(local_data))
                        label_x = float(local_times[peak_idx])
                        label_y = float(local_data[peak_idx])
                    else:
                        label_x = apex_time
                        label_y = float(np.interp(apex_time, times, plot_data))
                    y_offset = 0.03 * max(1.0, global_y_max)
                    ax.text(label_x, label_y + y_offset, f"P{number}",
                            ha="center", va="bottom", fontsize=peak_label_fs, color="black")

        ax.set_xlabel("Time (min)", fontsize=axis_label_fs)
        ax.set_ylabel("Normalized Intensity" if normalize else "Intensity", fontsize=axis_label_fs)
        ax.tick_params(axis='both', labelsize=tick_fs)
        ax.legend(loc='upper right', fontsize=legend_fs)
        if sample.ms_times is not None and len(sample.ms_times) > 0:
            ax.set_xlim(float(sample.ms_times[0]), float(sample.ms_times[-1]))
        if global_y_max > 0:
            # Keep label numbers clearly below the top frame line.
            y_upper = global_y_max * 1.18
            if normalize:
                y_upper = max(1.12, y_upper)
            ax.set_ylim(0, y_upper)
        if not normalize:
            ax.ticklabel_format(axis='y', style='scientific', scilimits=(-2, 3), useMathText=True)
            _shift_sci_offset_left(ax)
    else:
        n_panels = len(mz_values)
        fig, axes = plt.subplots(n_panels, 1, figsize=(10, 3 * n_panels))
        if n_panels == 1:
            axes = [axes]

        fig.suptitle(f"EIC Comparison: {sample.name}", fontsize=title_fs, fontweight='bold')

        for i, mz in enumerate(mz_values):
            eic = extract_eic(sample, mz, mz_window)
            if eic is not None and sample.ms_times is not None:
                times = sample.ms_times
                plot_data = smooth_data(eic, smoothing) if smoothing > 0 else eic
                if normalize and np.max(plot_data) > 0:
                    plot_data = plot_data / np.max(plot_data)

                axes[i].plot(
                    times,
                    plot_data,
                    color=config.EIC_COLORS[i % len(config.EIC_COLORS)],
                    linewidth=1.0,
                    label=f"m/z {mz:.2f}"
                )
                axes[i].set_xlabel("Time (min)")
                axes[i].set_ylabel("Normalized Intensity" if normalize else "Intensity")
                axes[i].xaxis.label.set_size(axis_label_fs)
                axes[i].yaxis.label.set_size(axis_label_fs)
                axes[i].tick_params(axis='both', labelsize=tick_fs)
                axes[i].legend(loc='upper right', fontsize=legend_fs)
                axes[i].set_xlim(float(times[0]), float(times[-1]))
                local_y_max = float(np.max(plot_data)) if len(plot_data) > 0 else 0.0
                if local_y_max > 0:
                    # Keep label numbers clearly below the top frame line.
                    y_upper = local_y_max * 1.18
                    if normalize:
                        y_upper = max(1.12, y_upper)
                    axes[i].set_ylim(0, y_upper)
                if not normalize:
                    axes[i].ticklabel_format(axis='y', style='scientific', scilimits=(-2, 3), useMathText=True)
                    _shift_sci_offset_left(axes[i])

                regions = selected_peaks_by_mz.get(f"{mz:.4f}", [])
                for region in regions:
                    start = float(region.get("start", times[0]))
                    end = float(region.get("end", times[-1]))
                    number = region.get("number")
                    apex_time = float(region.get("apex_time", (start + end) / 2.0))
                    if end <= start:
                        continue
                    mask = (times >= start) & (times <= end)
                    if not np.any(mask):
                        continue
                    axes[i].fill_between(times[mask], 0, plot_data[mask], color="gray", alpha=0.22, linewidth=0, zorder=0)
                    if number is not None:
                        local_times = times[mask]
                        local_data = plot_data[mask]
                        if len(local_data) > 0:
                            peak_idx = int(np.argmax(local_data))
                            label_x = float(local_times[peak_idx])
                            label_y = float(local_data[peak_idx])
                        else:
                            label_x = apex_time
                            label_y = float(np.interp(apex_time, times, plot_data))
                        y_offset = 0.03 * max(1.0, float(np.max(plot_data)))
                        axes[i].text(label_x, label_y + y_offset, f"P{number}",
                                     ha="center", va="bottom", fontsize=peak_label_fs, color="black")
            axes[i].set_title(f"EIC m/z {mz:.2f} (±{mz_window})", fontsize=panel_title_fs, fontweight='bold')

    plt.tight_layout()
    return fig


def export_figure(fig: matplotlib.figure.Figure, dpi: int = config.EXPORT_DPI, format: str = 'png') -> bytes:
    """
    Export figure to bytes in specified format with transparent background.

    Args:
        fig: Matplotlib Figure object
        dpi: Resolution in dots per inch
        format: Output format ('png', 'svg', 'pdf')

    Returns:
        Image/document as bytes
    """
    # Make all axes backgrounds transparent
    for ax in fig.get_axes():
        ax.set_facecolor('none')
    buf = io.BytesIO()
    fig.savefig(buf, format=format, dpi=dpi, bbox_inches='tight', facecolor='none', edgecolor='none', transparent=True)
    buf.seek(0)
    return buf.getvalue()


def export_figure_png(fig: matplotlib.figure.Figure, dpi: int = config.EXPORT_DPI) -> bytes:
    """Export figure to PNG bytes."""
    return export_figure(fig, dpi=dpi, format='png')


def export_figure_svg(fig: matplotlib.figure.Figure) -> bytes:
    """Export figure to SVG bytes with transparent background."""
    # Make all axes backgrounds transparent
    for ax in fig.get_axes():
        ax.set_facecolor('none')
    buf = io.BytesIO()
    fig.savefig(buf, format='svg', bbox_inches='tight', facecolor='none', edgecolor='none', transparent=True)
    buf.seek(0)
    return buf.getvalue()


def export_figure_pdf(fig: matplotlib.figure.Figure, dpi: int = config.EXPORT_DPI) -> bytes:
    """Export figure to PDF bytes."""
    return export_figure(fig, dpi=dpi, format='pdf')


def export_figure_to_file(fig: matplotlib.figure.Figure, filepath: str, dpi: int = config.EXPORT_DPI) -> None:
    """
    Export figure to file.

    Args:
        fig: Matplotlib Figure object
        filepath: Output file path
        dpi: Resolution in dots per inch
    """
    fig.savefig(filepath, dpi=dpi, bbox_inches='tight', facecolor='white')


def create_mass_spectrum_figure(mz: np.ndarray, intensity: np.ndarray,
                                 title: str = "Mass Spectrum",
                                 mz_range: tuple = None,
                                 highlight_peaks: list = None,
                                 deconv_results: list = None,
                                 style: dict = None) -> matplotlib.figure.Figure:
    """
    Create a mass spectrum figure with optional peak highlighting and deconvolution overlay.

    Args:
        mz: m/z array
        intensity: intensity array
        title: Figure title
        mz_range: Optional (min, max) to zoom
        highlight_peaks: List of m/z values to highlight
        deconv_results: Deconvolution results to overlay theoretical peaks
        style: Style settings dict

    Returns:
        Matplotlib Figure
    """
    style = style or {}
    fig_width = style.get('fig_width', 12)
    line_width = style.get('line_width', 0.8)
    show_grid = style.get('show_grid', True)

    if deconv_results:
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(fig_width, 8),
                                        gridspec_kw={'height_ratios': [2, 1]})
    else:
        fig, ax1 = plt.subplots(1, 1, figsize=(fig_width, 5))

    # Plot mass spectrum
    ax1.plot(mz, intensity, 'b-', linewidth=line_width)
    ax1.set_xlabel("m/z")
    ax1.set_ylabel("Intensity")
    ax1.set_title(title, fontweight='bold')

    if mz_range:
        ax1.set_xlim(mz_range)

    if show_grid:
        ax1.grid(True, alpha=0.3)

    ax1.ticklabel_format(axis='y', style='scientific', scilimits=(0, 0), useMathText=True)
    _shift_sci_offset_left(ax1)

    # Highlight peaks if provided
    if highlight_peaks:
        for peak_mz in highlight_peaks:
            ax1.axvline(x=peak_mz, color='red', linestyle='--', alpha=0.5, linewidth=0.5)

    # Plot deconvoluted mass spectrum
    if deconv_results and len(deconv_results) > 0:
        masses = [r['mass'] for r in deconv_results]
        intensities = [r['intensity'] for r in deconv_results]

        # Normalize intensities
        max_int = max(intensities) if intensities else 1
        norm_intensities = [i / max_int * 100 for i in intensities]

        ax2.bar(masses, norm_intensities, width=50, color='green', alpha=0.7)
        ax2.set_xlabel("Deconvoluted Mass (Da)")
        ax2.set_ylabel("Relative Intensity (%)")
        ax2.set_title("Deconvoluted Mass Spectrum", fontweight='bold')

        if show_grid:
            ax2.grid(True, alpha=0.3)

        # Add mass labels with appropriate precision
        for mass, rel_int in zip(masses, norm_intensities):
            if rel_int > 10:  # Only label significant peaks
                if mass >= 10000:
                    label_text = f"{mass:.1f}"
                else:
                    label_text = f"{mass:.2f}"
                ax2.annotate(label_text,
                           xy=(mass, rel_int),
                           xytext=(0, 5),
                           textcoords='offset points',
                           ha='center', fontsize=8)

    plt.tight_layout()
    return fig


def _plot_deconvoluted_masses_panel(
    ax_deconv,
    deconv_results: list,
    show_grid: bool = True,
    x_min_da: float = 1000.0,
    x_max_da: float = 50000.0,
    subtitle: Optional[str] = None,
    show_title: bool = True,
    show_obs_calc: bool = False,
    calc_mass_da=None,
    show_peak_labels: bool = True,
) -> None:
    """Render deconvoluted masses as a vertical-line spectrum on the given axis."""
    # Color palette for bars and labels
    bar_colors = ['#2ca02c', '#1f77b4', '#ff7f0e', '#d62728', '#9467bd',
                  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
    label_colors = ['#1a6b1a', '#0d4f8a', '#cc6600', '#a31d1d', '#6b4a91',
                    '#5c3a32', '#b8518f', '#4d4d4d', '#8a8b19', '#0f8a94']

    # User-configurable default display range (Da -> kDa for axis).
    x_min_kda = float(x_min_da) / 1000.0
    x_max_kda = float(x_max_da) / 1000.0
    if x_max_kda <= x_min_kda:
        x_min_kda, x_max_kda = 1.0, 50.0

    if deconv_results and len(deconv_results) > 0:
        masses = [r['mass'] for r in deconv_results]
        intensities = [r['intensity'] for r in deconv_results]

        max_int = max(intensities) if intensities else 1
        norm_intensities = [i / max_int * 100 for i in intensities]

        # Convert to kDa for x-axis
        masses_kda = [m / 1000 for m in masses]

        # Draw vertical lines (stem plot style) with different colors
        for i, (m_kda, intensity) in enumerate(zip(masses_kda, norm_intensities)):
            bar_color = bar_colors[i % len(bar_colors)]
            ax_deconv.vlines(x=m_kda, ymin=0, ymax=intensity, color=bar_color, linewidth=2)

        # Keep label spacing based on detected mass spread, but lock visible
        # x-axis to user-selected range.
        min_mass = min(masses_kda)
        max_mass = max(masses_kda)
        mass_range = max_mass - min_mass if max_mass > min_mass else max_mass * 0.1
        ax_deconv.set_xlim(x_min_kda, x_max_kda)
        # Relative intensity is normalized to 100%; keep axis at true range.
        ax_deconv.set_ylim(0, 100)

        # Add mass labels with side offsets and collision avoidance so labels
        # don't sit directly on top of bars.
        if not show_peak_labels:
            labeled_peaks = []  # skip label placement
        else:
            labeled_peaks = sorted(enumerate(zip(masses_kda, norm_intensities, masses)), key=lambda x: x[1][0])
        label_positions = []  # Track placed label anchors in data coordinates
        x_min, x_max = ax_deconv.get_xlim()
        y_top = ax_deconv.get_ylim()[1]

        # Keep labels close to bars; resolve most conflicts by moving upward.
        base_x_offset = max(mass_range * 0.008, 0.022)
        max_x_offset = max(mass_range * 0.024, 0.070)
        # Collision window includes approximate text width so labels do not
        # visually overlap even when anchor points are somewhat separated.
        x_collision = max(mass_range * 0.12, 0.30)
        y_collision = 8.0
        y_step = 7.0
        # Do not place label anchors on top of other bars.
        bar_avoid = max(mass_range * 0.006, 0.10)

        for sorted_idx, (orig_idx, (m_kda, intensity, mass_da)) in enumerate(labeled_peaks):
            if mass_da >= 10000:
                label_text = f"{mass_da:.1f}"
            else:
                label_text = f"{mass_da:.2f}"

            label_color = label_colors[orig_idx % len(label_colors)]

            # Prefer inward placement near edges; otherwise place toward
            # whichever side has more free horizontal space.
            edge_zone = 0.08 * (x_max - x_min)
            hard_edge = 1.15 * max_x_offset
            near_left_edge = m_kda <= x_min + max(edge_zone, hard_edge)
            near_right_edge = m_kda >= x_max - max(edge_zone, hard_edge)

            is_leftmost = (sorted_idx == 0)
            is_rightmost = (sorted_idx == len(labeled_peaks) - 1)

            if is_leftmost:
                preferred_side = 1
            elif is_rightmost:
                preferred_side = -1
            elif near_left_edge:
                preferred_side = 1
            elif near_right_edge:
                preferred_side = -1
            else:
                left_neighbors = [x for j, x in enumerate(masses_kda) if j != orig_idx and x < m_kda]
                right_neighbors = [x for j, x in enumerate(masses_kda) if j != orig_idx and x > m_kda]
                left_space = m_kda - (max(left_neighbors) if left_neighbors else x_min)
                right_space = (min(right_neighbors) if right_neighbors else x_max) - m_kda
                if left_space > right_space:
                    preferred_side = -1
                elif right_space > left_space:
                    preferred_side = 1
                else:
                    preferred_side = -1 if (sorted_idx % 2 == 0) else 1
            best_pos = None
            for tier in range(6):
                for side in (preferred_side, -preferred_side):
                    # First attempt uses preferred side only.
                    if tier == 0 and side != preferred_side:
                        continue

                    x_shift = min(base_x_offset * (1.0 + 0.12 * tier), max_x_offset)
                    cand_x = m_kda + side * x_shift
                    cand_y = intensity + 3.0 + y_step * tier

                    # Keep labels inside plot bounds with a small horizontal margin.
                    margin = max(base_x_offset * 0.35, 0.08)
                    cand_x = min(max(cand_x, x_min + margin), x_max - margin)
                    cand_y = min(cand_y, y_top - 2.0)

                    collides = False
                    for prev_x, prev_y in label_positions:
                        if abs(cand_x - prev_x) < x_collision and abs(cand_y - prev_y) < y_collision:
                            collides = True
                            break
                    if collides:
                        continue

                    # Keep label anchor away from other bar lines so text does
                    # not visually overlap unrelated peaks.
                    for j, other_x in enumerate(masses_kda):
                        if j == orig_idx:
                            continue
                        if abs(cand_x - other_x) < bar_avoid:
                            collides = True
                            break
                    if not collides:
                        best_pos = (cand_x, cand_y)
                        break
                if best_pos is not None:
                    break

            if best_pos is None:
                # Fallback: place near preferred side (not centered on bar).
                fallback_x = m_kda + preferred_side * max_x_offset
                fallback_x = min(max(fallback_x, x_min + base_x_offset), x_max - base_x_offset)
                best_pos = (fallback_x, min(intensity + 8.0, y_top - 2.0))

            label_x, label_y = best_pos

            # Force edge labels inward to avoid touching axes.
            near_left = m_kda <= x_min + hard_edge
            near_right = m_kda >= x_max - hard_edge
            if near_left:
                label_x = max(label_x, m_kda + base_x_offset)
            elif near_right:
                label_x = min(label_x, m_kda - base_x_offset)

            # If neighboring bars are very close, bias this label away from the
            # nearest neighbor so text does not visually overlap that bar.
            other_masses = [x for j, x in enumerate(masses_kda) if j != orig_idx]
            nearest_other = min(other_masses, key=lambda x: abs(x - m_kda)) if other_masses else None
            nearest_dist = abs(nearest_other - m_kda) if nearest_other is not None else float("inf")
            tight_cluster_thresh = max(mass_range * 0.015, 0.22)
            isolated_thresh = max(mass_range * 0.08, 0.80)
            force_center = False

            if nearest_dist > isolated_thresh and not (is_leftmost or is_rightmost):
                # Isolated bars read best with centered labels.
                label_x = m_kda
                force_center = True
            elif nearest_other is not None and nearest_dist < tight_cluster_thresh:
                if is_leftmost:
                    label_x = max(label_x, m_kda + 0.6 * base_x_offset)
                elif is_rightmost:
                    label_x = min(label_x, m_kda - 0.6 * base_x_offset)
                elif nearest_other < m_kda:
                    label_x = max(label_x, m_kda + 0.6 * base_x_offset)
                else:
                    label_x = min(label_x, m_kda - 0.6 * base_x_offset)

            label_positions.append((label_x, label_y))

            side = 0
            if label_x > m_kda:
                side = 1
            elif label_x < m_kda:
                side = -1

            if force_center:
                ha = 'center'
            elif side > 0:
                ha = 'left'
            elif side < 0:
                ha = 'right'
            else:
                ha = 'center'

            ax_deconv.annotate(
                label_text,
                (m_kda, intensity),
                xytext=(label_x, label_y),
                fontsize=6,
                ha=ha,
                va='bottom',
                color=label_color,
                fontweight='bold'
            )

        # Optional top-peak summary annotation for publication-style figures.
        # Place it to the right of the most intense peak without touching bars.
        if show_obs_calc and len(masses_kda) > 0 and calc_mass_da is not None:
            # Normalize calc_mass_da to a list
            if isinstance(calc_mass_da, (int, float)):
                calc_masses = [float(calc_mass_da)]
            else:
                calc_masses = [float(m) for m in calc_mass_da]

            top_idx = int(np.argmax(norm_intensities))
            top_x = masses_kda[top_idx]
            top_y = float(norm_intensities[top_idx])
            x_span = max(1e-6, (x_max - x_min))
            ann_x = min(x_max - 0.02 * x_span, top_x + 0.04 * x_span)
            ann_y = min(108.0, max(24.0, top_y * 0.84))
            pt_offset = 20  # points to the right of label anchor

            row = 0
            for cm in calc_masses:
                # Find best matching deconv result for this calc mass
                match_idx = int(np.argmin([abs(m - cm) for m in masses]))
                match_delta = abs(masses[match_idx] - cm)

                calc_val = f"{cm:.1f}"
                if match_delta <= 5.0:
                    obs_val = f"{masses[match_idx]:.1f}"
                    obs_color = label_colors[match_idx % len(label_colors)]
                else:
                    obs_val = "—"
                    obs_color = "#888"

                for lbl, val, lbl_color, val_color in [
                    ("calc:", calc_val, "black", "black"),
                    ("obs:",  obs_val,  "black", obs_color),
                ]:
                    row_y = ann_y - row * 8.0
                    ax_deconv.text(ann_x, row_y, lbl, ha='left', va='bottom',
                                   fontsize=8, fontweight='bold', color=lbl_color)
                    ax_deconv.annotate(val, xy=(ann_x, row_y),
                                       xytext=(pt_offset, 0), textcoords='offset points',
                                       ha='left', va='bottom',
                                       fontsize=8, fontweight='bold', color=val_color)
                    row += 1

        ax_deconv.set_xlabel("Mass (kDa)")
        ax_deconv.set_ylabel("Relative Intensity (%)")
        if show_title:
            title_y = 1.08 if subtitle else 1.03
            ax_deconv.set_title("Deconvoluted Masses", fontweight='bold', y=title_y)
        if subtitle:
            sub_y = 1.02 if show_title else 1.03
            ax_deconv.text(
                0.5, sub_y, subtitle,
                transform=ax_deconv.transAxes,
                ha='center', va='bottom',
                fontsize=7, fontweight='normal'
            )

        if show_grid:
            ax_deconv.grid(True, alpha=0.3)
        # Publication-style framing: keep only left and bottom axes.
        ax_deconv.spines['top'].set_visible(False)
        ax_deconv.spines['right'].set_visible(False)
    else:
        ax_deconv.text(0.5, 0.5, "No masses detected", ha='center', va='center', transform=ax_deconv.transAxes)
        if show_title:
            title_y = 1.08 if subtitle else 1.03
            ax_deconv.set_title("Deconvoluted Masses", fontweight='bold', y=title_y)
        if subtitle:
            sub_y = 1.02 if show_title else 1.03
            ax_deconv.text(
                0.5, sub_y, subtitle,
                transform=ax_deconv.transAxes,
                ha='center', va='bottom',
                fontsize=7, fontweight='normal'
            )
        ax_deconv.set_xlim(x_min_kda, x_max_kda)
        ax_deconv.set_ylim(0, 120)
        ax_deconv.spines['top'].set_visible(False)
        ax_deconv.spines['right'].set_visible(False)


def create_deconvolution_figure(sample, start_time: float, end_time: float,
                                 deconv_results: list,
                                 style: dict = None) -> matplotlib.figure.Figure:
    """
    Create a comprehensive deconvolution figure with chromatogram, mass spectrum, and results.

    Args:
        sample: SampleData object
        start_time: Start of selected region
        end_time: End of selected region
        deconv_results: Deconvolution results
        style: Style settings dict

    Returns:
        Matplotlib Figure
    """
    from analysis import sum_spectra_in_range, get_theoretical_mz

    style = style or {}
    fig_width = style.get('fig_width', 8)  # Smaller default
    line_width = style.get('line_width', 0.8)
    show_grid = style.get('show_grid', True)
    deconv_x_min_da = style.get('deconv_x_min_da', 1000.0)
    deconv_x_max_da = style.get('deconv_x_max_da', 50000.0)
    deconv_show_obs_calc = style.get('deconv_show_obs_calc', False)
    deconv_calc_mass_da = style.get('deconv_calc_mass_da')

    fig = plt.figure(figsize=(fig_width, 5.5))  # Smaller, less zoomed in

    # Create grid: top row for chromatogram, bottom left for spectrum, bottom right for deconv
    gs = fig.add_gridspec(2, 2, height_ratios=[1, 2], hspace=0.45, wspace=0.3)

    # Top: TIC with selected region highlighted
    ax_tic = fig.add_subplot(gs[0, :])

    if sample.tic is not None and sample.ms_times is not None:
        ax_tic.plot(sample.ms_times, sample.tic, 'b-', linewidth=line_width)
        ax_tic.axvspan(start_time, end_time, alpha=0.3, color='yellow', label='Selected region')
        ax_tic.set_xlabel("Time (min)")
        ax_tic.set_ylabel("TIC Intensity")
        ax_tic.set_title(f"TIC - Selected region: {start_time:.2f} - {end_time:.2f} min", fontweight='bold')
        ax_tic.legend()
        if show_grid:
            ax_tic.grid(True, alpha=0.3)
        ax_tic.ticklabel_format(axis='y', style='scientific', scilimits=(0, 0), useMathText=True)
        _shift_sci_offset_left(ax_tic)

    # Bottom left: Summed mass spectrum
    ax_spec = fig.add_subplot(gs[1, 0])

    mz, intensity = sum_spectra_in_range(sample, start_time, end_time)

    if len(mz) > 0:
        ax_spec.plot(mz, intensity, 'b-', linewidth=line_width)
        ax_spec.set_xlabel("m/z")
        ax_spec.set_ylabel("Intensity")
        ax_spec.set_title("Summed Mass Spectrum", fontweight='bold', y=1.03)
        if show_grid:
            ax_spec.grid(True, alpha=0.3)
        ax_spec.ticklabel_format(axis='y', style='scientific', scilimits=(0, 0), useMathText=True)
        _shift_sci_offset_left(ax_spec)

        # Add peak labels (only significant peaks > 20% of max)
        from analysis import find_spectrum_peaks
        peaks = find_spectrum_peaks(mz, intensity, height_threshold=0.2, min_distance=5, use_centroid=True)
        peak_mz_values = np.array([p['mz'] for p in peaks], dtype=float) if peaks else np.array([])
        for peak in peaks:
            ax_spec.annotate(
                f"{peak['mz']:.2f}",
                xy=(peak['mz'], peak['intensity']),
                xytext=(0, 3),
                textcoords='offset points',
                ha='center',
                fontsize=5,
                rotation=90
            )
        # Add headroom for labels
        y_max = intensity.max() if len(intensity) > 0 else 1
        ax_spec.set_ylim(0, y_max * 1.2)

        # Overlay theoretical charge-state guides for the top result.
        # Snap each guide to a nearby detected spectrum peak to avoid
        # visual mismatch between dashed guides and the blue trace.
        if deconv_results and len(deconv_results) > 0 and len(peak_mz_values) > 0:
            top_result = deconv_results[0]
            theoretical = get_theoretical_mz(top_result['mass'], top_result['charge_states'])
            snap_tolerance_da = 1.5
            used_peak_indices = set()
            for t in theoretical:
                nearest_idx = int(np.argmin(np.abs(peak_mz_values - t['mz'])))
                if nearest_idx in used_peak_indices:
                    continue
                nearest_mz = float(peak_mz_values[nearest_idx])
                if abs(nearest_mz - float(t['mz'])) <= snap_tolerance_da:
                    ax_spec.axvline(x=nearest_mz, color='red', linestyle='--', alpha=0.5, linewidth=0.5)
                    used_peak_indices.add(nearest_idx)

    # Bottom right: Deconvoluted masses (linear kDa scale with vertical lines)
    ax_deconv = fig.add_subplot(gs[1, 1])
    _plot_deconvoluted_masses_panel(
        ax_deconv,
        deconv_results,
        show_grid=show_grid,
        x_min_da=deconv_x_min_da,
        x_max_da=deconv_x_max_da,
        show_obs_calc=deconv_show_obs_calc,
        calc_mass_da=deconv_calc_mass_da,
    )

    plt.suptitle(f"Protein Deconvolution: {sample.name}", fontsize=10, fontweight='bold', y=0.97)

    return fig


def create_deconvoluted_masses_figure(
    sample_name: str,
    deconv_results: list,
    style: dict = None
) -> matplotlib.figure.Figure:
    """
    Create a standalone deconvoluted masses figure (single panel).

    Args:
        sample_name: Name of sample for title
        deconv_results: Deconvolution results (typically top-N already filtered)
        style: Style settings dict

    Returns:
        Matplotlib Figure
    """
    style = style or {}
    base_fig_width = style.get('fig_width', 8)
    show_grid = style.get('show_grid', True)
    deconv_x_min_da = style.get('deconv_x_min_da', 1000.0)
    deconv_x_max_da = style.get('deconv_x_max_da', 50000.0)
    deconv_show_obs_calc = style.get('deconv_show_obs_calc', False)
    deconv_calc_mass_da = style.get('deconv_calc_mass_da')
    deconv_show_peak_labels = style.get('deconv_show_peak_labels', True)
    deconv_show_title = style.get('deconv_show_title', True)
    deconv_show_subtitle = style.get('deconv_show_subtitle', True)
    sample_subtitle = (sample_name[:-2] if sample_name.lower().endswith(".d") else sample_name) if deconv_show_subtitle else None

    # Match the physical panel size used by create_deconvolution_figure()
    # for the bottom-right deconvoluted-masses subplot.
    base_fig_height = 5.5
    left, right = 0.125, 0.9
    bottom, top = 0.11, 0.88
    wspace = 0.3
    hspace = 0.45
    total_width_frac = right - left
    total_height_frac = top - bottom

    # GridSpec width/height allocation mirrors create_deconvolution_figure():
    # 2 columns with wspace=0.3, and row height ratios [1, 2] with hspace=0.45.
    panel_width_frac = total_width_frac / (2 + wspace)
    panel_height_frac = (2 * total_height_frac) / (1 + 2 + hspace)

    panel_width_in = base_fig_width * panel_width_frac
    panel_height_in = base_fig_height * panel_height_frac

    fig, ax = plt.subplots(1, 1, figsize=(panel_width_in, panel_height_in))
    _plot_deconvoluted_masses_panel(
        ax,
        deconv_results,
        show_grid=show_grid,
        x_min_da=deconv_x_min_da,
        x_max_da=deconv_x_max_da,
        subtitle=sample_subtitle,
        show_title=deconv_show_title,
        show_obs_calc=deconv_show_obs_calc,
        calc_mass_da=deconv_calc_mass_da,
        show_peak_labels=deconv_show_peak_labels,
    )
    plt.tight_layout(pad=0.8)
    return fig


def create_ion_selection_figure(
    mz: np.ndarray,
    intensity: np.ndarray,
    deconv_results: list,
    style: dict = None,
) -> matplotlib.figure.Figure:
    """Create a figure showing the m/z spectrum with colored markers for each
    deconvoluted component's selected ions (Agilent-style peak assignment).

    Args:
        mz: Raw m/z array of the summed spectrum.
        intensity: Raw intensity array of the summed spectrum.
        deconv_results: Deconvolution results containing ``ion_mzs``,
            ``ion_charges``, and ``ion_intensities`` per component.
        style: Style settings dict.

    Returns:
        Matplotlib Figure.
    """
    style = style or {}
    fig_width = style.get('fig_width', 12)
    line_width = style.get('line_width', 0.8)
    show_grid = style.get('show_grid', True)

    colors = ['#2ca02c', '#1f77b4', '#ff7f0e', '#d62728', '#9467bd',
              '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']

    n_results = len(deconv_results)
    if n_results == 0:
        fig, ax = plt.subplots(1, 1, figsize=(fig_width, 3))
        ax.text(0.5, 0.5, 'No results', ha='center', va='center', transform=ax.transAxes)
        return fig

    fig, axes = plt.subplots(n_results, 1, figsize=(fig_width, 2.2 * n_results),
                             sharex=True, squeeze=False)

    max_int = float(np.max(intensity)) if len(intensity) > 0 else 1.0

    for idx, r in enumerate(deconv_results):
        ax = axes[idx, 0]
        color = colors[idx % len(colors)]

        # Draw full spectrum in light gray
        ax.plot(mz, intensity, color='#cccccc', linewidth=0.5, zorder=1)

        # Highlight selected ion peaks
        ion_mzs = r.get('ion_mzs', [])
        ion_charges = r.get('ion_charges', [])
        ion_ints = r.get('ion_intensities', [])

        if ion_mzs:
            # For each ion, draw a colored line from 0 to its intensity on the
            # raw spectrum (interpolated).
            for mz_val, z, ion_int in zip(ion_mzs, ion_charges, ion_ints):
                # Interpolate intensity at this m/z from the raw spectrum
                raw_int = float(np.interp(mz_val, mz, intensity))
                ax.vlines(mz_val, 0, raw_int, color=color, linewidth=1.5, zorder=3)
                # Label with charge state
                ax.annotate(
                    f"z={z}",
                    xy=(mz_val, raw_int),
                    xytext=(0, 3),
                    textcoords='offset points',
                    ha='center', fontsize=6,
                    color=color, fontweight='bold',
                    zorder=4,
                )

        # Title with mass and charge range
        mass_val = r['mass']
        if mass_val >= 10000:
            mass_str = f"{mass_val:.1f}"
        else:
            mass_str = f"{mass_val:.2f}"
        charges = r.get('charge_states', [])
        rel_pct = r['intensity'] / deconv_results[0]['intensity'] * 100 if deconv_results[0]['intensity'] > 0 else 0
        charge_str = f"z={min(charges)}-{max(charges)}" if len(charges) > 1 else f"z={charges[0]}" if charges else ""
        ax.set_title(f"{mass_str} Da  ({charge_str}, {rel_pct:.0f}%)", fontsize=8,
                     fontweight='bold', color=color, loc='left')

        ax.set_ylabel("Intensity", fontsize=7)
        ax.set_ylim(0, max_int * 1.15)
        ax.ticklabel_format(axis='y', style='scientific', scilimits=(0, 0), useMathText=True)
        _shift_sci_offset_left(ax)
        if show_grid:
            ax.grid(True, alpha=0.2)

    axes[-1, 0].set_xlabel("m/z")
    fig.suptitle("Ion Selection per Component", fontsize=10, fontweight='bold')
    plt.tight_layout(rect=[0, 0, 1, 0.97])
    return fig


def create_report_info_page(
    sample_name: str,
    acq_method: Optional[str],
    app_version: str,
    time_range: Optional[tuple[float, float]],
    parameters: dict,
    results: Optional[list[dict]],
    acq_info: Optional[dict] = None,
) -> matplotlib.figure.Figure:
    """Render sample info + results table as a monospace-text report page (Agilent style).

    Args:
        sample_name: Name of the sample
        acq_method: Acquisition method string
        app_version: Application version
        time_range: (start, end) deconvolution time window, or None
        parameters: Dict of deconvolution parameters to display
        results: Deconvolution results list, or None
        acq_info: Optional dict of all acquisition metadata from acq.txt

    Returns:
        Matplotlib Figure (A4 portrait)
    """
    import datetime as _dt

    A4_W, A4_H = 8.27, 11.69  # inches
    fig = plt.figure(figsize=(A4_W, A4_H))
    fig.patch.set_facecolor('white')

    mono = {'family': 'monospace', 'fontsize': 9}
    sep_line = "=" * 70

    # Build text lines top-down
    lines: list[str] = []
    lines.append("Spectrum Deconvolution")
    lines.append(f"Sample Name: {sample_name}")
    if acq_method:
        lines.append(f"Method:      {acq_method}")
    lines.append("")
    lines.append(sep_line)

    # Acquisition info (two-column where possible)
    acq = acq_info or {}
    left_items = []
    right_items = []
    _map_left = [
        ('Acq. Operator', 'Acq. Operator'),
        ('Operator', 'Acq. Operator'),
        ('Acq. Instrument', 'Acq. Instrument'),
        ('Instrument', 'Acq. Instrument'),
        ('Injection Date', 'Injection Date'),
    ]
    _map_right = [
        ('Seq. Line', 'Seq. Line'),
        ('Location', 'Location'),
        ('Inj', 'Inj'),
        ('Inj Volume', 'Inj Volume'),
    ]
    seen = set()
    for acq_key, label in _map_left:
        if acq_key in acq and label not in seen:
            left_items.append(f"{label:18s}: {acq[acq_key]}")
            seen.add(label)
    for acq_key, label in _map_right:
        if acq_key in acq and label not in seen:
            right_items.append(f"{label:12s}: {acq[acq_key]}")
            seen.add(label)

    max_rows = max(len(left_items), len(right_items))
    for i in range(max_rows):
        left = left_items[i] if i < len(left_items) else ""
        right = right_items[i] if i < len(right_items) else ""
        lines.append(f"{left:45s}{right}")

    # Method info
    if 'Method' in acq and acq['Method'] != acq_method:
        lines.append(f"{'Method':18s}: {acq['Method']}")
    if 'Method Info' in acq:
        lines.append(f"{'Method Info':18s}: {acq['Method Info']}")

    lines.append("")
    lines.append(sep_line)

    # Deconvolution time range
    if time_range:
        lines.append(
            f"Deconvolution window: {time_range[0]:.3f} - {time_range[1]:.3f} min"
        )
        lines.append("")

    # Deconvolution Parameters section
    lines.append(f"{'Deconvolution Parameters':^70s}")
    lines.append(sep_line)
    lines.append("")
    if parameters:
        for key, val in parameters.items():
            lines.append(f"{key + ':':24s}{val}")
    else:
        lines.append("(default parameters)")
    lines.append("")

    # Results table
    if results:
        lines.append(sep_line)
        lines.append(f"{'Detected Masses':^70s}")
        lines.append(sep_line)
        lines.append("")
        hdr = f"{'Component':>10s}  {'Molecular':>12s}  {'Absolute':>12s}  {'Relative':>10s}"
        hdr2 = f"{'':>10s}  {'Weight':>12s}  {'Abundance':>12s}  {'Abundance':>10s}"
        lines.append(hdr)
        lines.append(hdr2)
        top_int = results[0]['intensity']
        for i, r in enumerate(results[:15]):
            label = chr(ord('A') + i) if i < 26 else str(i + 1)
            rel = r['intensity'] / top_int * 100
            lines.append(
                f"{label:>10s}  {r['mass']:>12.2f}  {r['intensity']:>12.0f}  {rel:>10.2f}"
            )
        lines.append("")
    elif results is not None:
        lines.append("")
        lines.append("No masses detected.")

    # Render all lines
    x0, y0 = 0.06, 0.95
    line_spacing = 0.017
    for i, line in enumerate(lines):
        y_pos = y0 - i * line_spacing
        if y_pos < 0.04:
            break
        fig.text(x0, y_pos, line, **mono, va='top')

    # Footer
    now_str = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    fig.text(0.06, 0.02, f"LC-MS Webapp v{app_version}  {now_str}",
             fontsize=8, family='monospace', color='#666666')
    fig.text(0.94, 0.02, "Page  1",
             fontsize=8, family='monospace', color='#666666', ha='right')

    return fig
