var totalRecordCount = 143;
var numberOfPages = Math.ceil(totalRecordCount/10);
buildPager(numberOfPages, 1);

var shiftId;
var origStartDate;
var startDateInEST;
var volunteerName;
var eventName;
var actionButton;

shiftId = "5aad352a-4685-f111-ab0e-7ced8da56148";
origStartDate = "Sun, 26 Jul 2026 16:00:00 GMT";
startDateInEST = SetDateToEST(origStartDate);
volunteerName = "Test Volunteer 91";
eventName = "Oakville latino festival";
actionButton = buildActionButton(shiftId);
$("#pendingShiftsTable").append("<tr><td>" + volunteerName + "</td><td>" + eventName + "</td><td>" + startDateInEST + "</td><td>5</td><td aria-label='action menu'>" + actionButton + "</tr></tr>");

shiftId = "533795ca-3d59-f111-a825-7ced8da648cd";
origStartDate = "Sat, 06 Jun 2026 15:30:00 GMT";
startDateInEST = SetDateToEST(origStartDate);
volunteerName = "Test Volunteer 35";
eventName = "Liberty and Unity Basketball Game";
actionButton = buildActionButton(shiftId);
$("#pendingShiftsTable").append("<tr><td>" + volunteerName + "</td><td>" + eventName + "</td><td>" + startDateInEST + "</td><td>4</td><td aria-label='action menu'>" + actionButton + "</tr></tr>");

shiftId = "038ce913-8679-f111-ab0e-0022483d9209";
origStartDate = "Sat, 11 Jul 2026 17:30:00 GMT";
startDateInEST = SetDateToEST(origStartDate);
volunteerName = "Test Volunteer 70";
eventName = "Because Beer";
actionButton = buildActionButton(shiftId);
$("#pendingShiftsTable").append("<tr><td>" + volunteerName + "</td><td>" + eventName + "</td><td>" + startDateInEST + "</td><td>11</td><td aria-label='action menu'>" + actionButton + "</tr></tr>");

