const express = require('express');
const formidable = require('formidable');
const fs = require('fs/promises');
const app = express();
const PORT = 3000;

const Timer = require('./Timer');
const CloneDetector = require('./CloneDetector');
const CloneStorage = require('./CloneStorage');
const FileStorage = require('./FileStorage');


// Express and Formidable stuff to receice a file for further processing
// --------------------
const form = formidable({multiples:false});

app.post('/', fileReceiver );
function fileReceiver(req, res, next) {
    form.parse(req, (err, fields, files) => {
        fs.readFile(files.data.filepath, { encoding: 'utf8' })
            .then( data => { return processFile(fields.name, data); });
    });
    return res.end('');
}

app.get('/', viewClones );
app.get('/timers', viewTimers );

const server = app.listen(PORT, () => { console.log('Listening for files on port', PORT); });


// Page generation for viewing current progress
// --------------------
function getStatistics() {
    let cloneStore = CloneStorage.getInstance();
    let fileStore = FileStorage.getInstance();
    let output = 'Processed ' + fileStore.numberOfFiles + ' files containing ' + cloneStore.numberOfClones + ' clones.'
    return output;
}

function lastFileTimersHTML() {
    if (!lastFile) return '';
    output = '<p>Timers for last file processed:</p>\n<ul>\n'
    let timers = Timer.getTimers(lastFile);
    for (t in timers) {
        output += '<li>' + t + ': ' + (timers[t] / (1000n)) + ' µs\n'
    }
    output += '</ul>\n';
    return output;
}

function listClonesHTML() {
    let cloneStore = CloneStorage.getInstance();
    let output = '';
    
    cloneStore.clones.forEach( clone => {
        output += '<hr>\n';
        output += '<h2>Source File: ' + clone.sourceName + '</h2>\n';
        output += '<p>Starting at line: ' + clone.sourceStart + ' , ending at line: ' + clone.sourceEnd + '</p>\n';
        output += '<ul>';
        clone.targets.forEach( target => {
            output += '<li>Found in ' + target.name + ' starting at line ' + target.startLine + '\n';            
        });
        output += '</ul>\n'
        output += '<h3>Contents:</h3>\n<pre><code>\n';
        output += clone.originalCode;
        output += '</code></pre>\n';
    });
    
    return output;
}

function listProcessedFilesHTML() {
    let fs = FileStorage.getInstance();
    let output = '<HR>\n<H2>Processed Files</H2>\n'
    output += fs.filenames.reduce( (out, name) => {
        out += '<li>' + name + '\n';
        return out;
    }, '<ul>\n');
    output += '</ul>\n';
    return output;
}

function viewClones(req, res, next) {
    let page='<HTML><HEAD><TITLE>CodeStream Clone Detector</TITLE></HEAD>\n';
    page += '<BODY><H1>CodeStream Clone Detector</H1>\n';
    page += '<P>' + getStatistics() + '</P>\n';
    page += '<p><a href="/timers">View timing statistics and graphs</a></p>\n'; //added to view timers page
    page += lastFileTimersHTML() + '\n';
    page += listClonesHTML() + '\n';
    page += listProcessedFilesHTML() + '\n';
    page += '</BODY></HTML>';
    res.send(page);
}

// -------------- View timers and graphs for the files processed --------------

// View the timers for the last file processed
function viewTimers(req, res, next) {
    let page='<HTML><HEAD><TITLE>CodeStream Clone Detector - Timers</TITLE>\n';
    page += '<meta charset="utf-8">\n';
    page += '<style>body{font-family:sans-serif;margin:2rem}svg{max-width:100%;height:auto}.grid{stroke:#ddd}.axis{stroke:#333}.chart{margin:2rem 0;max-width:1000px}</style>\n';
    page += '</HEAD>\n';
    page += '<BODY><H1>CodeStream Clone Detector - Timers</H1>\n';
    page += listTimersHTML() + '\n';
    page += viewGraph() + '\n';
    page += '</BODY></HTML>';
    res.send(page);
}

//Displays the graphs for processing time progression, top 10 files by clone targets, and processing time by lines of code
function viewGraph() {
    return '<section class="chart"><h2>Processing-time progression</h2>' +
        createXYGraphSVG(getProcessingTimeGraphData(), {
            title: 'Total processing time per file',
            xLabel: 'Files processed',
            yLabel: 'Microseconds',
            line: true, // True means plot a line connecting the points, false means just draw the points
            xFormat: value => Math.round(value).toString(), // Round the x values to the nearest integer for display
            formatY: value => value.toFixed(1) // Format the y values to one decimal place for display
        }) + '</section>';
}

// Helper functions for statistics and timers
// --------------------

//Standard dimensions for the graphs and colors for the lines, points, and bars
const CHART_WIDTH = 960;
const CHART_HEIGHT = 460;
const GRAPH_COLORS = {
    line: '#2563eb',
    point: '#0e9489',
    bar: '#7c3aed'
};

//Help function used to escape special characters in XML/HTML to prevent rendering issues or injection attacks
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Returns an array of objects containing the x (file index), y (total processing time in microseconds), and label (file name) for each processed file
function getProcessingTimeGraphData() {
    return allTimers.map((file, index) => ({
        x: index + 1,
        y: Number(file.timers?.total || 0n) / 1000,
        label: file.name
    }));
}



function createXYGraphSVG(data, options) {
    if (data.length === 0) {
        return '<p>' + escapeXml('No processed-file statistics are available yet.') + '</p>';
    }
    // Set standards for the graph dimensions, margins, and plot area
    const margin = { top: 30, right: 30, bottom: 75, left: 90 };
    const plotWidth = CHART_WIDTH - margin.left - margin.right;
    const plotHeight = CHART_HEIGHT - margin.top - margin.bottom;
    let minX = data[0].x;
    let maxX = data[0].x;
    let minY = Math.min(0, data[0].y);
    let maxY = data[0].y;

    // Determine the min and max values for x and y axes
    data.forEach(point => {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
    });
    // Adjusts the min and max values to ensure that the graph has a visible range, even if all points have the same value
    if (minX === maxX) {
        minX -= 1;
        maxX += 1;
    }
    if (minY === maxY) {
        maxY = minY + 1;
    }
    // Functions to calculate the pixel position of a given x or y value based on the graph dimensions and margins
    const xAt = value => margin.left + ((value - minX) / (maxX - minX)) * plotWidth;
    const yAt = value => margin.top + plotHeight - ((value - minY) / (maxY - minY)) * plotHeight;
    // Functions to format the x and y values for display on the axes, with default formatting if not provided in options
    const xFormat = options.xFormat || (value => Number.isInteger(value) ? String(value) : value.toFixed(1));
    const yFormat = options.formatY || (value => value.toFixed(1));
    // Start building the SVG string with the specified viewBox, role, and aria-label for accessibility
    let svg = '<svg viewBox="0 0 ' + CHART_WIDTH + ' ' + CHART_HEIGHT +
        '" role="img" aria-label="' + escapeXml(options.title) + '">';
    svg += '<title>' + escapeXml(options.title) + '</title>';

    // Draw grid lines and labels for the y-axis
    for (let i = 0; i <= 5; i++) {
        const y = margin.top + (plotHeight * i / 5);
        const value = maxY - ((maxY - minY) * i / 5);
        svg += '<line class="grid" x1="' + margin.left + '" y1="' + y +
            '" x2="' + (CHART_WIDTH - margin.right) + '" y2="' + y + '"/>';
        svg += '<text x="' + (margin.left - 10) + '" y="' + (y + 4) +
            '" text-anchor="end">' + escapeXml(yFormat(value)) + '</text>';
    }
    // Draw grid lines and labels for the x-axis
    for (let i = 0; i <= 5; i++) {
        const x = margin.left + (plotWidth * i / 5);
        const value = minX + ((maxX - minX) * i / 5);
        svg += '<line class="grid" x1="' + x + '" y1="' + margin.top +
            '" x2="' + x + '" y2="' + (margin.top + plotHeight) + '"/>';
        svg += '<text x="' + x + '" y="' + (margin.top + plotHeight + 22) +
            '" text-anchor="middle">' + escapeXml(xFormat(value)) + '</text>';
    }
    // Draw the axes for the graph
    svg += '<line class="axis" x1="' + margin.left + '" y1="' + margin.top +
        '" x2="' + margin.left + '" y2="' + (margin.top + plotHeight) + '"/>';
    svg += '<line class="axis" x1="' + margin.left + '" y1="' + (margin.top + plotHeight) +
        '" x2="' + (CHART_WIDTH - margin.right) + '" y2="' + (margin.top + plotHeight) + '"/>';

    // If the options specify that a line should be drawn, create a path element connecting the data points
    if (options.line) {
        const path = data.map((point, index) =>
            (index === 0 ? 'M' : 'L') + xAt(point.x).toFixed(2) + ',' + yAt(point.y).toFixed(2)
        ).join(' ');
        svg += '<path d="' + path + '" fill="none" stroke="' + GRAPH_COLORS.line +
            '" stroke-width="2"/>';
    }

    // Draw circles for each data point, with a title element for accessibility and tooltips
    data.forEach(point => {
        svg += '<circle cx="' + xAt(point.x).toFixed(2) + '" cy="' + yAt(point.y).toFixed(2) +
            '" r="' + (options.line ? 2 : 4) + '" fill="' +
            (options.line ? GRAPH_COLORS.line : GRAPH_COLORS.point) + '">';
        svg += '<title>' + escapeXml(point.label) + ': ' +
            escapeXml(yFormat(point.y)) + ' µs</title></circle>';
    });

    // Add labels for the x-axis and y-axis, with appropriate transformations for the y-axis label
    svg += '<text x="' + (margin.left + plotWidth / 2) + '" y="' +
        (CHART_HEIGHT - 15) + '" text-anchor="middle">' + escapeXml(options.xLabel) + '</text>';
    svg += '<text transform="translate(22 ' + (margin.top + plotHeight / 2) +
        ') rotate(-90)" text-anchor="middle">' + escapeXml(options.yLabel) + '</text>';
    return svg + '</svg>';
}

// Returns the sum of all timers for a given key across all files
const sumTimer = key => allTimers.reduce((sum, file) => sum + (file.timers?.[key] || 0n), 0n);

// Returns the average time in microseconds for a given sum of nanoseconds and count of items
function averageMicroSeconds(totalTime, count) {
  if (count === 0) {
    return 'n/a'; // avoids BigInt divide-by-zero
  }
  const decimals = 3;
  const scale = 10n ** BigInt(decimals); // this ensures it keeps 3 decimal places during integer division
  const averageTime = Number((totalTime * scale) / BigInt(count)) / Number(scale); // average in nanoseconds, with fractions
  return (averageTime / 1000).toFixed(decimals) + ' µs'; // convert ns to µs
}

//Summarizes the following statistics: total time per file, match time per file, time/Lines-of-code ratio, and rolling average over the last 100 files
function listTimersHTML() {
    let output = '<HR>\n<H2>Timers for all processed files</H2>\n'

    // average time per file
    output += '<p>Average total time per file: ' + averageMicroSeconds(sumTimer('total'), allTimers.length) + '</p>\n';

    // average match time per file
    output += '<p>Average match time per file: ' + averageMicroSeconds(sumTimer('match'), allTimers.length) + '</p>\n';

    // adds up the total time and total lines of code across all files, then calculates the average time per line of code
    const totalTime  = allTimers.reduce((sum, file) => sum + (file.timers.total || 0n), 0n);
    const totalLines = allTimers.reduce((sum, file) => sum + (file.lines || 0), 0);

    let averageTimePerLine;
    if (totalLines > 0) {
        // Scale up before dividing to keep 3 decimal places, then convert at the end
        const scaledTotalTime = (totalTime * 1000n) / BigInt(totalLines);   // time units * 1000 per line
        averageTimePerLine = Number(scaledTotalTime) / 1000;                        // back to a float
    } 
    else {
        averageTimePerLine = null;
    }

    // Display the average time per line of code (n/a if no lines of code were processed)
    output += '<p>Average time per line of code: ' +
    (averageTimePerLine === null ? 'n/a' : (averageTimePerLine / 1000).toFixed(3) + ' µs') + '</p>\n';

    //rolling average over last 100 files
    let last100 = allTimers.slice(-100);
    const last100TotalTime = last100.reduce((sum, file) => sum + (file.timers?.total || 0n), 0n);
    output += '<p>Rolling average over last 100 files: ' + averageMicroSeconds(last100TotalTime, last100.length) + '</p>\n';

    return output;
}


// Some helper functions
// --------------------
// PASS is used to insert functions in a Promise stream and pass on all input parameters untouched.
PASS = fn => d => {
    try {
        fn(d);
        return d;
    } catch (e) {
        throw e;
    }
};

const STATS_FREQ = 100;
const URL = process.env.URL || 'http://localhost:8080/';
var lastFile = null;
const allTimers = [];

function maybePrintStatistics(file, cloneDetector, cloneStore) {
    if (0 == cloneDetector.numberOfProcessedFiles % STATS_FREQ) {
        console.log('Processed', cloneDetector.numberOfProcessedFiles, 'files and found', cloneStore.numberOfClones, 'clones.');
        let timers = Timer.getTimers(file);
        let str = 'Timers for last file processed: ';
        for (t in timers) {
            str += t + ': ' + (timers[t] / (1000n)) + ' µs '
        }
        console.log(str);
        console.log('List of found clones available at', URL);
    }

    return file;
}

// Processing of the file
// --------------------
function processFile(filename, contents) {
    let cd = new CloneDetector();
    let cloneStore = CloneStorage.getInstance();

    return Promise.resolve({name: filename, contents: contents} )
        //.then( PASS( (file) => console.log('Processing file:', file.name) ))
        .then( (file) => Timer.startTimer(file, 'total') )
        .then( (file) => cd.preprocess(file) )
        .then( (file) => cd.transform(file) )

        .then( (file) => Timer.startTimer(file, 'match') )
        .then( (file) => cd.matchDetect(file) )
        .then( (file) => cloneStore.storeClones(file) )
        .then( (file) => Timer.endTimer(file, 'match') )

        .then( PASS( (file) => allTimers.push({ name: file.name, lines: file.lines?.length, timers: Timer.getTimers(file) })) )
        .then( (file) => cd.storeFile(file) )
        .then( (file) => Timer.endTimer(file, 'total') )
        .then( PASS( (file) => lastFile = file ))
        .then( PASS( (file) => maybePrintStatistics(file, cd, cloneStore) ))
    // TODO Store the timers from every file (or every 10th file), create a new landing page /timers
    // and display more in depth statistics there. Examples include:
    // average times per file, average times per last 100 files, last 1000 files.
    // Perhaps throw in a graph over all files.
        .catch( console.log );
};

/*
1. Preprocessing: Remove uninteresting code, determine source and comparison units/granularities
2. Transformation: One or more extraction and/or transformation techniques are applied to the preprocessed code to obtain an intermediate representation of the code.
3. Match Detection: Transformed units (and/or metrics for those units) are compared to find similar source units.
4. Formatting: Locations of identified clones in the transformed units are mapped to the original code base by file location and line number.
5. Post-Processing and Filtering: Visualisation of clones and manual analysis to filter out false positives
6. Aggregation: Clone pairs are aggregated to form clone classes or families, in order to reduce the amount of data and facilitate analysis.
*/
